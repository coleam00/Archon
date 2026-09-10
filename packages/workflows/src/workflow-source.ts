/**
 * Run-owned capture of a workflow's executable SOURCE.
 *
 * Archon has always had two different directories hiding behind one `cwd`:
 *
 *   - the **source** a workflow, its commands, and its scripts are READ from, and
 *   - the **target** workspace the run ACTS on (provider turns, bash, git, output).
 *
 * Discovery reads the source; everything downstream re-derived it from the target's
 * `cwd`, so a workflow authored in checkout A but executed against worktree B looked
 * for `B/.archon/...` and found nothing. That gap was papered over by copying the
 * whole `.archon` tree into B, which dirtied B's git status, fed B's validators
 * foreign packages, and (because the copy is not scope-aware) carried `.archon/.env`
 * and megabytes of `state/` along with it.
 *
 * This module replaces that copy with a capture the RUN owns: the source directories
 * are frozen once, before the workflow is even selected, and every later lookup
 * resolves against the capture instead of the target. Two consequences matter:
 *
 *   - **The target stays clean.** Nothing is written into B at all.
 *   - **The run stops moving under itself.** Editing or deleting A mid-run cannot
 *     change the graph a paused run resumes into.
 *
 * The capture is the SOLE executable source for its run, not a convenience copy. That
 * is why a capture that cannot be taken, recorded, or verified fails the run instead of
 * degrading to live source: a silent fallback would reintroduce exactly the drift the
 * capture exists to remove. The one exception is a run created before captures existed,
 * which has no record to honor and resumes the way it always did, with a warning.
 *
 * SCOPE: every source scope a static `include:` can reach is captured — project, global
 * (`~/.archon/`), and, in source builds, the on-disk bundled defaults. Freezing only the
 * project scope would leave a hole: a project workflow that includes a global one would
 * still change shape across a resume. In a compiled binary the bundled defaults are
 * embedded constants rather than files, so they cannot move under a run at all; the
 * manifest records the engine version, which is what distinguishes one binary's bundled
 * set from another's.
 *
 * Runtime `workflow:` children are deliberately NOT part of the closure. A child is not a
 * run until it starts and freezes its own source — see {@link resolveChildDiscoveryRoot}.
 */
import {
  mkdir,
  readdir,
  copyFile,
  rm,
  rename,
  stat,
  lstat,
  realpath,
  readFile,
  writeFile,
} from 'fs/promises';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, sep } from 'path';
import { z } from '@hono/zod-openapi';
import { createLogger } from '@archon/paths';
import * as archonPaths from '@archon/paths';
import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import {
  BUNDLED_COMMANDS,
  BUNDLED_SCRIPT_PACKS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_OWNERS,
  isBinaryBuild,
} from './defaults/bundled-defaults';
import {
  readWorkflowSourceState,
  workflowSourceConfigSchema,
  type WorkflowSourceConfig,
} from './schemas/workflow-run';
import { parsePackagedResourceReference } from './packaged-workflow';
import type { WorkflowConfig } from './deps';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.source');
  return cachedLog;
}

const PROJECT_SCOPE_DIR = 'project';
const GLOBAL_SCOPE_DIR = 'global';
const BUNDLED_SCOPE_DIR = 'bundled';
const MANIFEST_FILE = 'manifest.json';

/**
 * The only directories excluded from a capture.
 *
 * Deliberately tiny. An earlier version also skipped `node_modules`, `.venv`, and `venv`
 * on the theory that they are caches — but a packaged script may legitimately import from
 * a sibling `node_modules` or run against a checked-in virtualenv, so excluding them
 * produced a script that worked live and failed only once captured. Saving disk is not
 * worth breaking a workflow that runs today.
 *
 * What remains has to be provably not-executable-input:
 *  - `.git` is VCS metadata. Nothing reads it as source, and copying it can dwarf the
 *    tree it belongs to.
 *  - `__pycache__` is derived bytecode Python regenerates on demand. Copying it does not
 *    just waste space: stale `.pyc` files next to edited sources can change behavior.
 */
const SKIP_DIRECTORIES = new Set(['.git', '__pycache__']);

/**
 * Soft ceiling on a capture, in bytes. Exceeding it is NOT an error — a repo is
 * allowed a large scripts tree, and failing the run over it would be worse than the
 * cost. It logs once so an author who accidentally parks a dataset in
 * `.archon/scripts/` finds out from the run rather than from their disk.
 */
const CAPTURE_WARN_BYTES = 64 * 1024 * 1024;

/**
 * The roots every source lookup resolves under.
 *
 * Naming the three scopes explicitly is what lets one set of resolvers serve both a live
 * checkout and a run's frozen capture: the live form derives them from `ARCHON_HOME` and
 * a project root, the captured form from a capture directory, and nothing downstream has
 * to know which it was handed.
 */
interface WorkflowSourceRootPaths {
  /** Project root (the directory containing `.archon/`), or null with no project context. */
  readonly project: string | null;
  readonly globalWorkflows: string;
  readonly globalCommands: string;
  readonly globalScripts: string;
  /** Directory holding packaged bundled workflows (the parent of the defaults folder). */
  readonly bundledWorkflows: string;
  /** Directory holding bundled default commands. */
  readonly bundledCommands: string;
}

export { workflowSourceConfigSchema, type WorkflowSourceConfig } from './schemas/workflow-run';

/** Out-of-band identity that every late read from a captured source must recheck. */
export interface WorkflowSourceAnchor {
  readonly root: string;
  readonly digest: string;
  readonly config: WorkflowSourceConfig;
}

export interface LiveWorkflowSourceRoots extends WorkflowSourceRootPaths {
  readonly kind: 'live';
  readonly config: WorkflowSourceConfig;
}

export interface CapturedWorkflowSourceRoots extends WorkflowSourceRootPaths {
  readonly kind: 'captured';
  readonly anchor: WorkflowSourceAnchor;
}

export type WorkflowSourceRoots = LiveWorkflowSourceRoots | CapturedWorkflowSourceRoots;

export function workflowSourceConfigForRoots(roots: WorkflowSourceRoots): WorkflowSourceConfig {
  return roots.kind === 'captured' ? roots.anchor.config : roots.config;
}

export const DEFAULT_WORKFLOW_SOURCE_CONFIG: WorkflowSourceConfig = {
  load_default_workflows: true,
  load_default_commands: true,
};

/**
 * Narrow an install's config down to the settings a capture must freeze.
 *
 * Every caller that captures needs exactly this projection, and a second copy of it is
 * how one entry point ends up freezing a different set of directories than another:
 * a repo pointing `commands.folder` outside `.archon/commands` would have its commands
 * captured by `workflow run` and missed by `workflow test`.
 */
export function workflowSourceConfigFrom(config: WorkflowConfig): WorkflowSourceConfig {
  return {
    load_default_workflows: config.defaults?.loadDefaultWorkflows ?? true,
    load_default_commands: config.defaults?.loadDefaultCommands ?? true,
    ...(config.commands?.folder !== undefined ? { command_folder: config.commands.folder } : {}),
  };
}

/** Roots for reading source live off disk, exactly as Archon always has. */
export function liveSourceRoots(
  project: string | null,
  config: WorkflowSourceConfig = DEFAULT_WORKFLOW_SOURCE_CONFIG
): LiveWorkflowSourceRoots {
  return {
    project,
    globalWorkflows: archonPaths.getHomeWorkflowsPath(),
    globalCommands: archonPaths.getHomeCommandsPath(),
    globalScripts: archonPaths.getHomeScriptsPath(),
    bundledWorkflows: dirname(archonPaths.getDefaultWorkflowsPath()),
    bundledCommands: archonPaths.getDefaultCommandsPath(),
    kind: 'live',
    config,
  };
}

/**
 * Roots for reading a run's frozen capture.
 *
 * Bundled defaults use the same captured paths in every build. A compiled binary
 * materializes its embedded constants into this tree when the capture is created.
 */
export function capturedSourceRoots(anchor: WorkflowSourceAnchor): CapturedWorkflowSourceRoots {
  const captureRoot = anchor.root;
  return {
    project: join(captureRoot, PROJECT_SCOPE_DIR),
    globalWorkflows: join(captureRoot, GLOBAL_SCOPE_DIR, 'workflows'),
    globalCommands: join(captureRoot, GLOBAL_SCOPE_DIR, 'commands'),
    globalScripts: join(captureRoot, GLOBAL_SCOPE_DIR, 'scripts'),
    // Always the capture, binary or not. A binary's bundled set is materialized into it
    // at capture time, which is what lets a paused run resume across an Archon upgrade
    // instead of failing because its bundled bytes could not be verified.
    bundledWorkflows: join(captureRoot, BUNDLED_SCOPE_DIR, 'workflows'),
    bundledCommands: join(captureRoot, BUNDLED_SCOPE_DIR, 'commands', 'defaults'),
    kind: 'captured',
    anchor,
  };
}

/**
 * What a capture records about itself.
 *
 * `digest` is the reason this file exists. A directory that merely EXISTS proves nothing
 * about the bytes inside it: a partial restore, an interrupted sync, or an edit under the
 * artifacts tree would all pass an existence check while changing what the run executes.
 * Recomputing the digest on load is what makes the capture authoritative rather than
 * merely present.
 *
 * `engine_version` is recorded, never enforced. It lets someone reading a run afterwards
 * tell "this resumed under a different Archon" apart from "this changed" — including for
 * the bundled scope a binary embeds rather than copies.
 *
 * `workflow_name` is stamped after selection (see {@link recordSelectedWorkflow}), because
 * the capture is taken BEFORE discovery. That ordering is what stops a run executing one
 * moment's YAML against another moment's scripts.
 */
export const workflowSourceManifestSchema = z.object({
  version: z.literal(1),
  engine_version: z.string(),
  origin: z.string(),
  captured_at: z.string(),
  digest: z.string(),
  file_count: z.number(),
  byte_count: z.number(),
  scopes: z.array(z.enum([PROJECT_SCOPE_DIR, GLOBAL_SCOPE_DIR, BUNDLED_SCOPE_DIR])),
  source_config: workflowSourceConfigSchema,
  /** Absent until the caller has selected which workflow this run executes. */
  workflow_name: z.string().optional(),
});

export type WorkflowSourceManifest = z.infer<typeof workflowSourceManifestSchema>;

/**
 * A capture whose bytes could not be trusted.
 *
 * Distinct from an ordinary Error so callers can fail a run closed on it rather than
 * treat it as one more reason to fall back to live source. Falling back is precisely what
 * the capture exists to prevent.
 */
export class WorkflowSourceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowSourceIntegrityError';
  }
}

/** Where a run's executable source came from, and what was frozen. */
export interface WorkflowSourceCapture {
  /** The authoring directory this was captured from. */
  origin: string;
  manifest: WorkflowSourceManifest;
  /** Pinned identity retained for every later filesystem-backed read. */
  anchor: WorkflowSourceAnchor;
}

/** Project-relative directories that hold executable source. */
function projectSourceDirs(commandFolder: string | undefined): string[] {
  return dedupeNestedDirs([
    ...archonPaths.getWorkflowFolderSearchPaths(),
    '.archon/scripts',
    ...archonPaths.getCommandFolderSearchPaths(commandFolder),
  ]);
}

/**
 * Drop any directory contained by another in the list, so nesting cannot produce a
 * duplicate copy. Compares on path segments rather than string prefixes: `.archon/cmd`
 * is not inside `.archon/c` even though one string starts with the other.
 */
function dedupeNestedDirs(dirs: readonly string[]): string[] {
  const normalized = [...new Set(dirs.map(d => d.split(/[\\/]/).filter(Boolean).join(sep)))];
  return normalized.filter(
    candidate =>
      !normalized.some(other => other !== candidate && (candidate + sep).startsWith(other + sep))
  );
}

/** True when `path` exists and is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** A file found while walking a live source tree. */
interface TreeFile {
  /** Path relative to the walked root, platform separator. */
  readonly relPath: string;
  readonly absPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * One live source tree, walked once.
 *
 * Listing before acting is what lets the bundled scope be checked for change and copied by
 * the same walk: the copy consumes the listing, and the cache compares two listings.
 */
interface TreeListing {
  /** Every directory in the tree, relative to the root, `''` for the root itself. */
  readonly dirs: readonly string[];
  readonly files: readonly TreeFile[];
}

/**
 * Recursively list `root`, skipping cache directories.
 *
 * Directory symlinks are followed rather than preserved, so a link pointing at one of its
 * own ancestors would otherwise re-enter the same tree: the walk only stops when the kernel
 * refuses the path with ELOOP, by which point the same files have been visited a dozen-plus
 * times. `ancestors` holds the canonical (symlink-resolved) path of every directory open
 * above the current one, which cuts the cycle at the first repeat.
 */
async function listTree(root: string): Promise<TreeListing> {
  const dirs: string[] = [];
  const files: TreeFile[] = [];

  const walk = async (dir: string, rel: string, ancestors: ReadonlySet<string>): Promise<void> => {
    dirs.push(rel);
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      const relPath = rel === '' ? entry.name : join(rel, entry.name);

      // Symlinks are DEREFERENCED into ordinary files. Preserving the link would keep a
      // live reference to a path outside the capture, which is the exact mutability this
      // module exists to remove. `stat` (not `lstat`) resolves the target; a dangling
      // link throws and is skipped below rather than failing the whole capture.
      let info;
      try {
        info = await stat(absPath);
      } catch (error) {
        getLog().warn(
          { err: error as Error, path: absPath },
          'workflow.source_capture_entry_skipped'
        );
        continue;
      }

      if (info.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        let canonical: string;
        try {
          canonical = await realpath(absPath);
        } catch (error) {
          getLog().warn(
            { err: error as Error, path: absPath },
            'workflow.source_capture_entry_skipped'
          );
          continue;
        }
        if (ancestors.has(canonical)) {
          // A link back into a directory we are already inside. Copying it would duplicate
          // that subtree under itself, so record it and move on.
          getLog().warn({ path: absPath, canonical }, 'workflow.source_capture_cycle_skipped');
          continue;
        }
        await walk(absPath, relPath, new Set([...ancestors, canonical]));
        continue;
      }

      if (!info.isFile()) continue; // sockets, fifos, devices — nothing a workflow reads

      files.push({ relPath, absPath, size: info.size, mtimeMs: info.mtimeMs });
    }
  };

  // Seed the cycle guard with this root's canonical path so a link straight back to the
  // top of the tree is caught at depth one.
  const rootCanonical = await realpath(root).catch(() => root);
  await walk(root, '', new Set([rootCanonical]));
  return { dirs, files };
}

/** Copy a listed tree into `to`. Empty directories are recreated too. */
async function copyListing(
  listing: TreeListing,
  to: string
): Promise<{ files: number; bytes: number }> {
  for (const dir of listing.dirs) await mkdir(join(to, dir), { recursive: true });
  let bytes = 0;
  for (const file of listing.files) {
    await copyFile(file.absPath, join(to, file.relPath));
    bytes += file.size;
  }
  return { files: listing.files.length, bytes };
}

/**
 * One bundled file, held ready to be written into a capture.
 *
 * It IS its own digest entry: `relPath` is already capture-relative, under the `bundled`
 * scope directory, so the scope can be folded into a capture's digest without a second
 * pass over what was just written.
 */
interface BundledFile extends DigestEntry {
  readonly content: string | Buffer;
}

/**
 * The bundled scope this process holds, ready to be written into a capture.
 *
 * Why it exists: `captureWorkflowSource` used to copy the whole bundled scope and then
 * re-read every copied byte to hash it, on every capture — and `runChildWorkflow` captures
 * once per child spawn. On this checkout that was 200 files read twice and hashed per
 * spawn, none of it the workflow under test (#2924).
 *
 * The bytes still have to BE in each capture — that is what lets a run that statically
 * included a bundled workflow prove on resume that it did not change under an Archon
 * upgrade — so what is hoisted is reading and hashing them, never writing them. A binary
 * already keeps its bundled set in memory as constants and writes it out per capture; this
 * gives a source build the same shape, from one read of the two on-disk trees.
 *
 * Why the copy is rechecked instead of memoized for the life of the process: in a source
 * build those two trees are the checkout's own `.archon/workflows` and `.archon/commands`,
 * and a running Archon writes there itself — `PUT`/`DELETE /api/workflows/:name` write
 * under `<cwd>/.archon/workflows`, which for a maintainer running Archon from source IS
 * the checkout. A stale workflow catalogue is a wrong answer, not a slow one, so every
 * reuse revalidates against the live trees first and any difference re-reads them. A
 * binary's constants cannot move under the process and are read once.
 *
 * Deliberately NOT the content-addressed on-disk cache `script-discovery.ts` publishes
 * bundled script packs into. That cache works because its input is already in memory, so
 * hashing it is free, and because a script node executes from the cached path, which has
 * to be stable and shared. Here the bytes must land inside each capture regardless, so a
 * shared directory would be an extra hop rather than the destination — and on a source
 * build a content key would have to read the whole tree to compute, which is the cost this
 * removes. What it borrows is the principle: key on an identity that changes when the
 * bytes do.
 */
interface BundledScope {
  /** Identity of the build these bytes came from. */
  readonly key: string;
  /** Fingerprint of the live trees they were read from; empty for a binary's constants. */
  readonly stamp: string;
  /** Capture-relative directories, including ones with no files of their own. */
  readonly dirs: readonly string[];
  readonly files: readonly BundledFile[];
  readonly byteCount: number;
}

/** Accumulator shared by both branches that build a {@link BundledScope}. */
function bundledScopeBuilder(): {
  add: (relPath: string, content: string | Buffer) => void;
  addDir: (relPath: string) => void;
  result: () => Omit<BundledScope, 'key' | 'stamp'>;
} {
  const dirs: string[] = [];
  const files: BundledFile[] = [];
  let byteCount = 0;

  const seen = new Set<string>();
  const addDir = (relPath: string): void => {
    const scoped = join(BUNDLED_SCOPE_DIR, relPath);
    if (seen.has(scoped)) return;
    seen.add(scoped);
    dirs.push(scoped);
  };

  return {
    addDir,
    add: (relPath, content): void => {
      addDir(dirname(relPath));
      files.push({
        relPath: join(BUNDLED_SCOPE_DIR, relPath),
        content,
        hash: createHash('sha256').update(content).digest('hex'),
      });
      byteCount += Buffer.byteLength(content);
    },
    result: () => ({ dirs, files, byteCount }),
  };
}

/**
 * Read a binary's embedded bundled defaults, in the same layout a source build keeps them
 * in on disk.
 *
 * Mirroring the on-disk shape is the whole trick: every resolver already knows how to read
 * bundled workflows, commands, and scripts from a directory, so once the constants are
 * files under the capture's roots, the ordinary filesystem path serves a binary too and no
 * resolver needs a second way to find them.
 */
function readBundledConstants(): Omit<BundledScope, 'key' | 'stamp'> {
  const { add: write, result } = bundledScopeBuilder();

  for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    // A packaged bundled workflow lives under `<pack>/<workflow>/`; a bare one under
    // `defaults/`. The owners map is what distinguishes them, exactly as on disk.
    const owner = BUNDLED_WORKFLOW_OWNERS[name];
    const relative = owner
      ? join('workflows', owner.pack, owner.workflow, `${name}.yaml`)
      : join('workflows', 'defaults', `${name}.yaml`);
    write(relative, content);
  }

  for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
    const packaged = parsePackagedResourceReference(name);
    const relative = packaged
      ? join(
          'workflows',
          packaged.owner.pack,
          packaged.owner.workflow,
          'commands',
          `${packaged.name}.md`
        )
      : join('commands', 'defaults', `${name}.md`);
    write(relative, content);
  }

  for (const [pack, bundled] of Object.entries(BUNDLED_SCRIPT_PACKS)) {
    for (const [relativePath, content] of Object.entries(bundled.files)) {
      write(join('workflows', pack, relativePath), content);
    }
  }

  return result();
}

/** Read a source build's on-disk bundled trees, hashing each file as it is read. */
async function readBundledTrees(
  listings: readonly { name: string; listing: TreeListing }[]
): Promise<Omit<BundledScope, 'key' | 'stamp'>> {
  const { add, addDir, result } = bundledScopeBuilder();

  for (const { name, listing } of listings) {
    for (const dir of listing.dirs) addDir(dir === '' ? name : join(name, dir));
    for (const file of listing.files) add(join(name, file.relPath), await readFile(file.absPath));
  }

  return result();
}

let bundledScope: BundledScope | undefined;

/** The two on-disk roots a source build keeps its bundled defaults under. */
function bundledSourceRoots(): { name: string; from: string }[] {
  return [
    { name: 'workflows', from: dirname(archonPaths.getDefaultWorkflowsPath()) },
    { name: 'commands', from: dirname(archonPaths.getDefaultCommandsPath()) },
  ];
}

/**
 * Identity of the live bundled trees: their shape plus every file's size and mtime.
 *
 * Size and mtime is the freshness signal incremental build tools run on. It cannot see an
 * edit that preserves both, which re-reading every byte would — but re-reading every byte
 * is the cost being removed here, and every capture is still digest-verified against the
 * bytes it actually contains before anything executes from it.
 */
function stampListings(listings: readonly { name: string; listing: TreeListing }[]): string {
  const hash = createHash('sha256');
  for (const { name, listing } of listings) {
    hash.update(`scope\0${name}\n`);
    for (const dir of listing.dirs) hash.update(`d\0${dir}\n`);
    for (const file of listing.files) {
      hash.update(`f\0${file.relPath}\0${String(file.size)}\0${String(file.mtimeMs)}\n`);
    }
  }
  return hash.digest('hex');
}

/** This build's bundled bytes, read or revalidated as the build requires. */
async function resolveBundledScope(): Promise<BundledScope | undefined> {
  if (isBinaryBuild()) {
    const key = `binary\0${BUNDLED_VERSION}`;
    if (bundledScope?.key !== key) {
      const read = readBundledConstants();
      // A binary with no embedded bundled set has no bundled scope to capture, exactly as
      // a source build with no bundled directories on disk has none.
      if (read.files.length === 0) return undefined;
      bundledScope = { key, stamp: '', ...read };
    }
    return bundledScope;
  }

  const roots = bundledSourceRoots();
  const listings: { name: string; listing: TreeListing }[] = [];
  for (const { name, from } of roots) {
    if (await isDirectory(from)) listings.push({ name, listing: await listTree(from) });
  }
  // Nothing on disk means no bundled scope. An existing but EMPTY root still counts: it is
  // captured as an empty scope directory, which is what a resolver reading it expects.
  if (listings.length === 0) return undefined;

  const key = `source\0${roots.map(r => r.from).join('\0')}`;
  const stamp = stampListings(listings);
  if (bundledScope?.key !== key || bundledScope.stamp !== stamp) {
    bundledScope = { key, stamp, ...(await readBundledTrees(listings)) };
  }
  return bundledScope;
}

/** Write this build's bundled bytes into a staged capture. */
async function writeBundledScope(scope: BundledScope, staging: string): Promise<void> {
  for (const dir of scope.dirs) await mkdir(join(staging, dir), { recursive: true });
  for (const file of scope.files) await writeFile(join(staging, file.relPath), file.content);
}

/** One captured file's contribution to the capture digest. */
interface DigestEntry {
  /** Capture-relative path, platform separator. */
  readonly relPath: string;
  /** sha256 of the file's bytes, hex. */
  readonly hash: string;
}

/**
 * Fold per-file digests into the capture's digest.
 *
 * Path-and-bytes, sorted, so the value depends only on what was captured and never on
 * walk order or timestamps. The sort compares the platform-separated path and the hash
 * takes the `/`-normalized one; both halves are load-bearing for compatibility, because a
 * capture written by an older build is re-verified by this function and any change to
 * either would read as tampering. The manifest is excluded because it carries this value.
 */
function foldDigest(entries: readonly DigestEntry[]): string {
  const hash = createHash('sha256');
  const sorted = [...entries].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  );
  for (const entry of sorted) {
    hash.update(entry.relPath.split(sep).join('/'));
    hash.update('\0');
    hash.update(entry.hash);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Hash every file under `root`, reading each one.
 *
 * `skipScope` names a top-level scope directory whose per-file digests the caller already
 * holds — the bundled scope, written from bytes this process is still holding. Everything
 * else is read here, which is what makes the digest a statement about bytes, not paths.
 *
 * `bytes` is what was actually read, not what the caller expected to be there. It is the
 * only phase whose byte volume no other counter already holds, and a phase reporting zero
 * bytes while reading a megabyte is the way a measurement lies to whoever reads it.
 */
async function digestEntries(
  root: string,
  skipScope?: string
): Promise<{ entries: DigestEntry[]; bytes: number }> {
  const entries: DigestEntry[] = [];
  let bytes = 0;

  const walk = async (dir: string, rel: string): Promise<void> => {
    let dirEntries;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      const relPath = rel === '' ? entry.name : join(rel, entry.name);
      if (entry.isDirectory()) {
        if (rel === '' && entry.name === skipScope) continue;
        await walk(join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (relPath === MANIFEST_FILE) continue;
        const content = await readFile(join(dir, entry.name));
        bytes += content.byteLength;
        entries.push({ relPath, hash: createHash('sha256').update(content).digest('hex') });
      }
    }
  };
  await walk(root, '');

  return { entries, bytes };
}

/** Content digest over every captured file. */
async function digestTree(root: string): Promise<string> {
  return foldDigest((await digestEntries(root)).entries);
}

async function writeManifest(captureRoot: string, manifest: WorkflowSourceManifest): Promise<void> {
  await writeFile(join(captureRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The contiguous blocks one capture spends its time in.
 *
 * Named here rather than in the measuring script because the names have to keep meaning
 * the same thing as the code moves: a phase is a range of {@link captureWorkflowSource},
 * and a reader comparing one platform's numbers with another's is comparing these ranges.
 */
export const CAPTURE_PHASES = [
  /** Probe which mutable source directories exist and are worth capturing. */
  'scan',
  /** Clear and create the `.partial` staging root. */
  'stage',
  /** Walk each mutable source tree, listing its directories and files. */
  'walk',
  /** Recreate those directories in staging and copy every listed file into them. */
  'copy',
  /** Resolve this build's bundled bytes: revalidate the cached scope, or read it. */
  'bundled_read',
  /** Write those bytes into staging, one file at a time. */
  'bundled_write',
  /** Read back and hash every non-bundled captured file, then fold the capture digest. */
  'digest',
  /** Write `manifest.json`. */
  'manifest',
  /** Remove any prior capture at the destination and rename staging into place. */
  'publish',
] as const;

export type CapturePhase = (typeof CAPTURE_PHASES)[number];

/** What one phase spent, and what it spent it on. */
export interface CapturePhaseTotals {
  ms: number;
  /** Directories walked or created. */
  dirs: number;
  /** Files walked, copied, written, or hashed. */
  files: number;
  /** Bytes those files carry. */
  bytes: number;
}

/**
 * Measurement hook for one capture.
 *
 * Production callers pass nothing and get {@link NO_PROFILER}, which adds one function
 * call per phase — nine per capture — and no clock reads, allocations, or syscalls. The
 * only caller that passes a real one is `scripts/capture-cost.ts`, so a normal run never
 * pays for a measurement nobody asked for.
 */
export interface CaptureProfiler {
  time<T>(phase: CapturePhase, work: () => Promise<T>): Promise<T>;
  count(phase: CapturePhase, counts: Partial<Omit<CapturePhaseTotals, 'ms'>>): void;
}

/** The profiler an unmeasured capture runs against. */
const NO_PROFILER: CaptureProfiler = {
  time: (_phase, work) => work(),
  count: () => undefined,
};

/**
 * A profiler and the totals it accumulates.
 *
 * `totals` is live: it is the same object the returned profiler writes into, so a caller
 * reads it after the capture resolves rather than being handed a snapshot mid-flight.
 */
export function createCaptureProfiler(): {
  profiler: CaptureProfiler;
  totals: Record<CapturePhase, CapturePhaseTotals>;
} {
  const totals = Object.fromEntries(
    CAPTURE_PHASES.map(phase => [phase, { ms: 0, dirs: 0, files: 0, bytes: 0 }])
  ) as Record<CapturePhase, CapturePhaseTotals>;

  return {
    totals,
    profiler: {
      time: async <T>(phase: CapturePhase, work: () => Promise<T>): Promise<T> => {
        const started = performance.now();
        try {
          return await work();
        } finally {
          totals[phase].ms += performance.now() - started;
        }
      },
      count: (phase, counts): void => {
        const total = totals[phase];
        total.dirs += counts.dirs ?? 0;
        total.files += counts.files ?? 0;
        total.bytes += counts.bytes ?? 0;
      },
    },
  };
}

/**
 * Freeze `sourceRoot`'s executable source, plus every other statically reachable scope,
 * into `captureRoot`.
 *
 * Throws on failure. A capture is the run's only executable source, so a caller that
 * cannot take one must fail the run rather than proceed against live files.
 *
 * The capture is built in a sibling `.partial` directory and renamed into place, so a
 * failure part-way through can never leave a half-populated capture that later reads
 * would treat as authoritative.
 */
export async function captureWorkflowSource(opts: {
  sourceRoot: string;
  captureRoot: string;
  commandFolder?: string;
  sourceConfig?: WorkflowSourceConfig;
  /**
   * Measure where this capture spends its time. Off unless a caller asks — see
   * {@link CaptureProfiler}. Passing one changes nothing the capture produces.
   */
  profiler?: CaptureProfiler;
}): Promise<WorkflowSourceCapture> {
  const {
    sourceRoot,
    captureRoot,
    commandFolder,
    sourceConfig = DEFAULT_WORKFLOW_SOURCE_CONFIG,
    profiler = NO_PROFILER,
  } = opts;

  // (relative destination, absolute origin) pairs, one per MUTABLE directory worth copying.
  // The bundled scope is not among them: it is this build's own, read once into a
  // {@link BundledScope} and written from there.
  const jobs: { dest: string; from: string; scope: 'project' | 'global' }[] = [];

  await profiler.time('scan', async () => {
    for (const dir of projectSourceDirs(commandFolder)) {
      const from = join(sourceRoot, dir);
      if (await isDirectory(from))
        jobs.push({ dest: join(PROJECT_SCOPE_DIR, dir), from, scope: 'project' });
    }
    for (const [name, from] of [
      ['workflows', archonPaths.getHomeWorkflowsPath()],
      ['commands', archonPaths.getHomeCommandsPath()],
      ['scripts', archonPaths.getHomeScriptsPath()],
    ] as const) {
      if (await isDirectory(from))
        jobs.push({ dest: join(GLOBAL_SCOPE_DIR, name), from, scope: 'global' });
    }
  });

  const staging = `${captureRoot}.partial`;
  await profiler.time('stage', () => rm(staging, { recursive: true, force: true }));

  let fileCount = 0;
  let byteCount = 0;
  const scopesCaptured = new Set<'project' | 'global' | 'bundled'>(jobs.map(j => j.scope));
  try {
    await profiler.time('stage', () => mkdir(staging, { recursive: true }));
    for (const job of jobs) {
      const target = join(staging, job.dest);
      await profiler.time('copy', () => mkdir(dirname(target), { recursive: true }));
      const listing = await profiler.time('walk', () => listTree(job.from));
      profiler.count('walk', { dirs: listing.dirs.length, files: listing.files.length });
      const copied = await profiler.time('copy', () => copyListing(listing, target));
      profiler.count('copy', {
        dirs: listing.dirs.length,
        files: copied.files,
        bytes: copied.bytes,
      });
      fileCount += copied.files;
      byteCount += copied.bytes;
    }

    // The run's own bundled bytes, written from what this process already holds. They have
    // to be present, not referenced: that is what lets a run that statically included a
    // bundled workflow prove on resume that it did not change under an Archon upgrade.
    const bundled = await profiler.time('bundled_read', () => resolveBundledScope());
    if (bundled) {
      await profiler.time('bundled_write', () => writeBundledScope(bundled, staging));
      profiler.count('bundled_write', {
        dirs: bundled.dirs.length,
        files: bundled.files.length,
        bytes: bundled.byteCount,
      });
      fileCount += bundled.files.length;
      byteCount += bundled.byteCount;
      scopesCaptured.add('bundled');
    }

    // The bundled files were written from bytes whose hashes are already known, so reading
    // them back would restate what the scope already carries. Everything else is read.
    const digest = await profiler.time('digest', async () => {
      const read = await digestEntries(staging, bundled ? BUNDLED_SCOPE_DIR : undefined);
      profiler.count('digest', { files: read.entries.length, bytes: read.bytes });
      return foldDigest([...read.entries, ...(bundled?.files ?? [])]);
    });
    const manifest: WorkflowSourceManifest = {
      version: 1,
      engine_version: BUNDLED_VERSION,
      origin: sourceRoot,
      captured_at: new Date().toISOString(),
      digest,
      file_count: fileCount,
      byte_count: byteCount,
      scopes: [...scopesCaptured],
      source_config: sourceConfig,
    };
    await profiler.time('manifest', () => writeManifest(staging, manifest));

    // Replace rather than merge: a stale capture at this path would silently mix two
    // vintages of source, which is the failure this module exists to prevent.
    await profiler.time('publish', async () => {
      await rm(captureRoot, { recursive: true, force: true });
      await mkdir(dirname(captureRoot), { recursive: true });
      await rename(staging, captureRoot);
    });

    if (byteCount > CAPTURE_WARN_BYTES) {
      getLog().warn(
        { sourceRoot, captureRoot, fileCount, byteCount, limitBytes: CAPTURE_WARN_BYTES },
        'workflow.source_capture_large'
      );
    }
    getLog().debug(
      { sourceRoot, captureRoot, fileCount, byteCount, scopes: manifest.scopes },
      'workflow.source_captured'
    );
    return {
      origin: sourceRoot,
      manifest,
      anchor: { root: captureRoot, digest: manifest.digest, config: manifest.source_config },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {
      /* best-effort: the partial directory is inert, and the original error matters more */
    });
    throw error;
  }
}

/**
 * Stamp the selected workflow onto an existing capture.
 *
 * Selection happens after the capture because discovery must read the frozen bytes, not
 * whatever is on disk a moment later. The manifest is excluded from the digest, so
 * rewriting it here cannot invalidate the capture it describes.
 */
export async function recordSelectedWorkflow(
  captureRoot: string,
  workflowName: string
): Promise<void> {
  const manifest = await readManifest(captureRoot);
  await writeManifest(captureRoot, { ...manifest, workflow_name: workflowName });
}

async function readManifest(captureRoot: string): Promise<WorkflowSourceManifest> {
  let raw: string;
  try {
    raw = await readFile(join(captureRoot, MANIFEST_FILE), 'utf-8');
  } catch (error) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source capture at ${captureRoot} has no manifest: ${(error as Error).message}`
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source manifest at ${captureRoot} is not valid JSON: ${(error as Error).message}`
    );
  }
  const parsed = workflowSourceManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source manifest at ${captureRoot} is not a shape this build understands: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

/**
 * Load a capture and prove its bytes are the ones that were frozen.
 *
 * Throws {@link WorkflowSourceIntegrityError} when the manifest is missing, unreadable, of
 * an unknown shape, or when the digest no longer matches. Every one of those means the
 * run's executable source cannot be established, which is a reason to stop rather than to
 * quietly execute something else.
 */
export async function loadWorkflowSource(
  captureRoot: string,
  /**
   * The digest the RUN recorded, when the caller has it.
   *
   * Without this, verification is circular: the manifest is inside the capture, so
   * replacing the whole directory — files and manifest together — with a different but
   * internally consistent capture passes every check. The run row holds the digest
   * out-of-band, and comparing against it is what closes that.
   */
  expectedDigest?: string,
  /** The source resolution config the RUN recorded, when new enough to have one. */
  expectedConfig?: WorkflowSourceConfig
): Promise<WorkflowSourceCapture> {
  const manifest = await readManifest(captureRoot);
  if (expectedDigest !== undefined && manifest.digest !== expectedDigest) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source capture at ${captureRoot} is not the one this run recorded ` +
        `(run expects ${expectedDigest.slice(0, 12)}…, capture claims ` +
        `${manifest.digest.slice(0, 12)}…). The capture has been replaced.`
    );
  }
  if (
    expectedConfig !== undefined &&
    !isDeepStrictEqual(
      definedSourceConfig(manifest.source_config),
      definedSourceConfig(expectedConfig)
    )
  ) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source capture at ${captureRoot} has different resolution settings than this ` +
        'run recorded. The capture manifest has changed.'
    );
  }
  const digest = await digestTree(captureRoot);
  if (digest !== manifest.digest) {
    throw new WorkflowSourceIntegrityError(
      `Workflow source capture at ${captureRoot} does not match its recorded digest ` +
        `(expected ${manifest.digest.slice(0, 12)}…, found ${digest.slice(0, 12)}…). ` +
        'The captured source has changed since the run started.'
    );
  }
  if (manifest.engine_version !== BUNDLED_VERSION) {
    // Recorded, never enforced: the verified captured bytes remain authoritative across
    // an upgrade; the version is provenance for diagnostics, not source identity.
    getLog().warn(
      { captureRoot, capturedBy: manifest.engine_version, runningOn: BUNDLED_VERSION },
      'workflow.source_engine_version_changed'
    );
  }
  return {
    origin: manifest.origin,
    manifest,
    anchor: {
      root: captureRoot,
      digest: expectedDigest ?? manifest.digest,
      config: expectedConfig ?? manifest.source_config,
    },
  };
}

function definedSourceConfig(config: WorkflowSourceConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

/** Verify a captured root against its retained anchor immediately before a filesystem read. */
export async function assertWorkflowSourceIntegrity(roots: WorkflowSourceRoots): Promise<void> {
  if (roots.kind === 'live') return;
  await loadWorkflowSource(roots.anchor.root, roots.anchor.digest, roots.anchor.config);
}

/**
 * The verified capture a run recorded at start, manifest included.
 *
 * Returns the CAPTURE rather than its path because every caller needs the manifest too —
 * its `source_config` decides how those bytes resolve, and a caller handed only the path
 * rebuilt the roots from defaults, which is how a resume re-discovered a different DAG.
 *
 * Throws {@link WorkflowSourceIntegrityError} when the run HAS a record but the capture
 * cannot be verified. Returns `undefined` only when the run has no record at all — a run
 * created before captures existed, which resumes against live source because its original
 * bytes were never stored and cannot be reconstructed.
 */
export async function resolveRunSourceCapture(
  metadata: Record<string, unknown> | undefined
): Promise<WorkflowSourceCapture | undefined> {
  const state = readWorkflowSourceState(metadata);
  if (state.kind === 'unreadable') {
    // NOT the same as having no record. This run recorded something; we simply cannot
    // read it. Resolving live here would execute source the run never agreed to.
    throw new WorkflowSourceIntegrityError(
      `This run's workflow source record cannot be read by this build: ${state.detail}`
    );
  }
  if (state.kind === 'absent') return undefined;
  const capture = await loadWorkflowSource(
    state.record.root,
    state.record.digest,
    state.record.source_config
  );
  if (state.record.source_config === undefined) {
    getLog().warn(
      {
        captureRoot: state.record.root,
        warning:
          'This pre-change run did not record source resolution settings outside its capture. ' +
          'The manifest settings are used for this read; a resume pins them on the run row.',
      },
      'workflow.source_config_legacy_manifest_anchor'
    );
  }
  return capture;
}

/**
 * The AUTHORING directory a run was captured from.
 *
 * Deliberately different from {@link resolveRunSourceCapture}, and the difference is the
 * whole contract for sub-runs: a run freezes its own source, but a `workflow:` child that
 * has not started yet is not a run, so it must not be frozen into its parent.
 *
 * Two behaviors depend on reading the live origin here rather than the parent's capture:
 * a parent may author a workflow mid-flight and then execute it as a child, and — the
 * case with a test on it — a fan-out child cancelled at a gate is recovered by removing
 * the gate from the child workflow and resuming the parent. Resolving that child from the
 * parent's frozen copy would re-drive the OLD gated definition forever, so the fix could
 * never take. The child's own run captures at its own start, which is where its
 * determinism begins.
 *
 * Returns `undefined` only for a historical parent with no source record. Once a parent
 * records an authoring directory, an unreadable record or unavailable directory fails
 * closed so a child cannot silently capture a same-named workflow from the target cwd.
 */
export async function resolveChildDiscoveryRoot(
  metadata: Record<string, unknown> | undefined
): Promise<string | undefined> {
  const state = readWorkflowSourceState(metadata);
  if (state.kind === 'absent') return undefined;
  if (state.kind === 'unreadable') {
    throw new WorkflowSourceIntegrityError(
      `This run's workflow source record cannot be read by this build: ${state.detail}`
    );
  }
  if (!(await isDirectory(state.record.origin))) {
    throw new WorkflowSourceIntegrityError(
      `This run's recorded authoring source is unavailable at ${state.record.origin}. ` +
        'A child workflow cannot start from a different checkout.'
    );
  }
  return state.record.origin;
}
