import { createHash } from 'crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { execFileAsync } from '@archon/git';
import * as archonPaths from '@archon/paths';
import { z } from 'zod';
import type { ExtraWorkflowSource } from '../schemas/run-metadata';

/**
 * Workflows read from a git ref of the project's own repository.
 *
 * Git is touched in exactly one place, {@link syncExtraSource}: it resolves the ref to a
 * commit and writes that commit's tree into a snapshot directory under `ARCHON_HOME`.
 * Discovery and capture then read the snapshot like any other folder, so a run can never
 * see a ref that moved after its capture, and nothing here runs in the background.
 *
 * Snapshot layout, one directory per (project, ref, path):
 *   `<ARCHON_HOME>/extra-sources/<project>/<source>/source.json`  what was synced
 *   `<ARCHON_HOME>/extra-sources/<project>/<source>/tree/`        the ref's files under `path`
 */

const SNAPSHOT_META_FILE = 'source.json';
const SNAPSHOT_TREE_DIR = 'tree';
/** The folder in the tree that holds workflows, like `.archon/workflows` in a project. */
export const EXTRA_WORKFLOWS_DIR = 'workflows';
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

const snapshotMetaSchema = z
  .object({
    ref: z.string(),
    path: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    synced_at: z.string(),
    /** False when the repository has no remote to fetch from and the ref was read locally. */
    fetched: z.boolean(),
  })
  .strict();

export type ExtraSourceSnapshotMeta = z.infer<typeof snapshotMetaSchema>;

export interface ExtraSourceSnapshot {
  /** The snapshot directory, which holds `source.json` and `tree/`. */
  readonly dir: string;
  /** Where the ref's workflows are: `<dir>/tree/workflows`. */
  readonly workflowsDir: string;
  readonly meta: ExtraSourceSnapshotMeta;
}

/** Thrown when a configured source has no snapshot yet; its message names the fix. */
export class ExtraSourceNotSyncedError extends Error {
  constructor(source: ExtraWorkflowSource) {
    super(
      `Extra workflow source "${source.ref}" (path "${source.path}") has not been synced. ` +
        'Run `archon workflow sync` in this project.'
    );
    this.name = 'ExtraSourceNotSyncedError';
  }
}

function hashOf(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

/**
 * The snapshot directory of `source` for the checkout at `projectRoot`.
 *
 * Keyed by the checkout's real path, so moving the checkout means syncing again, which
 * reports itself as "not synced" instead of reading another project's snapshot.
 */
export async function extraSourceDir(
  projectRoot: string,
  source: ExtraWorkflowSource
): Promise<string> {
  const project = hashOf(await realpath(projectRoot)).slice(0, 16);
  return join(
    archonPaths.getArchonHome(),
    'extra-sources',
    project,
    hashOf(source.ref, source.path).slice(0, 16)
  );
}

/** The snapshot of `source`, or undefined when it was never synced. */
export async function readExtraSourceSnapshot(
  projectRoot: string,
  source: ExtraWorkflowSource
): Promise<ExtraSourceSnapshot | undefined> {
  const dir = await extraSourceDir(projectRoot, source);
  let raw: string;
  try {
    raw = await readFile(join(dir, SNAPSHOT_META_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const meta = snapshotMetaSchema.parse(JSON.parse(raw));
  return { dir, workflowsDir: join(dir, SNAPSHOT_TREE_DIR, EXTRA_WORKFLOWS_DIR), meta };
}

export interface ExtraSourceSyncResult {
  source: ExtraWorkflowSource;
  commit: string;
  fetched: boolean;
  files: number;
}

async function git(projectRoot: string, args: string[], maxBuffer?: number): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', projectRoot, ...args], {
    ...(maxBuffer ? { maxBuffer } : {}),
  });
  return stdout;
}

/**
 * Resolve `source.ref` to a commit. With a remote the ref is fetched first; a fetch that
 * fails is an error, never a quiet fall back to a stale local copy. Only a repository
 * with no such remote reads the ref locally, and the result says so.
 */
async function resolveCommit(
  projectRoot: string,
  source: ExtraWorkflowSource,
  remote: string
): Promise<{ commit: string; fetched: boolean }> {
  let hasRemote = true;
  try {
    await git(projectRoot, ['remote', 'get-url', remote]);
  } catch {
    hasRemote = false;
  }
  if (hasRemote) {
    try {
      await git(projectRoot, ['fetch', '--quiet', '--no-tags', remote, source.ref]);
    } catch (error) {
      throw new Error(
        `Could not fetch "${source.ref}" from remote "${remote}" for an extra workflow source: ` +
          (error as Error).message,
        { cause: error }
      );
    }
    const commit = (
      await git(projectRoot, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    ).trim();
    return { commit, fetched: true };
  }
  try {
    const commit = (
      await git(projectRoot, ['rev-parse', '--verify', `${source.ref}^{commit}`])
    ).trim();
    return { commit, fetched: false };
  } catch (error) {
    throw new Error(
      `Extra workflow source "${source.ref}" does not exist in this repository, which has no ` +
        `remote "${remote}" to fetch it from.`,
      { cause: error }
    );
  }
}

interface TreeEntry {
  mode: string;
  oid: string;
  /** Path relative to the source's `path`. */
  rel: string;
}

async function listTree(
  projectRoot: string,
  commit: string,
  source: ExtraWorkflowSource
): Promise<TreeEntry[]> {
  const prefix = source.path === '.' ? '' : `${source.path.replace(/\/+$/, '')}/`;
  const args = ['ls-tree', '-r', '-z', commit];
  if (prefix) args.push('--', prefix);
  const output = await git(projectRoot, args, 64 * 1024 * 1024);
  const entries: TreeEntry[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const rel = record.slice(tab + 1).slice(prefix.length);
    if (type !== 'blob' || mode === '120000') {
      throw new Error(
        `Extra workflow source "${source.ref}" holds ${mode === '120000' ? 'a symlink' : `a ${type}`} ` +
          `at "${prefix}${rel}"; only regular files can be synced.`
      );
    }
    entries.push({ mode, oid, rel });
  }
  return entries;
}

/**
 * Write the tree of `source.ref` into its snapshot, replacing the previous one.
 *
 * `remote` is the git remote to fetch from (the project's `worktree.remote`, else
 * `origin`). The new tree is built beside the old snapshot and swapped in with renames,
 * so a reader sees the old snapshot or the new one, never a half-written tree.
 */
export async function syncExtraSource(
  projectRoot: string,
  source: ExtraWorkflowSource,
  remote = 'origin'
): Promise<ExtraSourceSyncResult> {
  const { commit, fetched } = await resolveCommit(projectRoot, source, remote);
  const entries = await listTree(projectRoot, commit, source);
  if (!entries.some(entry => entry.rel.startsWith(`${EXTRA_WORKFLOWS_DIR}/`))) {
    throw new Error(
      `Extra workflow source "${source.ref}" has no "${EXTRA_WORKFLOWS_DIR}/" folder at path ` +
        `"${source.path}" (commit ${commit.slice(0, 12)}).`
    );
  }

  const dir = await extraSourceDir(projectRoot, source);
  const staging = `${dir}.staging-${process.pid}`;
  const previous = `${dir}.previous-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  try {
    for (const entry of entries) {
      const content = await git(projectRoot, ['cat-file', 'blob', entry.oid], MAX_BLOB_BYTES);
      if (content.includes('\0')) {
        throw new Error(
          `Extra workflow source "${source.ref}" holds a binary file at "${entry.rel}"; only text ` +
            'files can be synced.'
        );
      }
      const target = join(staging, SNAPSHOT_TREE_DIR, entry.rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
    }
    const meta: ExtraSourceSnapshotMeta = {
      ref: source.ref,
      path: source.path,
      commit,
      synced_at: new Date().toISOString(),
      fetched,
    };
    await writeFile(join(staging, SNAPSHOT_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);

    await mkdir(dirname(dir), { recursive: true });
    const hadPrevious = await stat(dir).then(
      () => true,
      () => false
    );
    if (hadPrevious) await rename(dir, previous);
    try {
      await rename(staging, dir);
    } catch (error) {
      if (hadPrevious) await rename(previous, dir).catch(() => undefined);
      throw error;
    }
    await rm(previous, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
  return { source, commit, fetched, files: entries.length };
}
