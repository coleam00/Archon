/**
 * Read-only checkout observation (#3305, #3375).
 *
 * Produces a {@link CheckoutObservation}: the commit a checkout sits on plus a manifest of
 * only the paths that differ from it. Every read goes through Git plumbing or `lstat`/
 * `readlink`; nothing here writes the index, refs, or worktree. `git status` runs with
 * optional locks disabled so it cannot refresh the index as a side effect, and content ids
 * come from `git hash-object` without `-w`.
 *
 * Observation never refuses anything. A checkout Archon cannot read becomes an
 * `unavailable` or `incomplete` observation that consumers can see and act on.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecutionContext } from '@archon/providers/types';
import { ARTIFACT_POINTER_TYPE } from './schemas/artifact-pointer';
import {
  CHECKOUT_MANIFEST_VERSION,
  type CheckoutManifest,
  type CheckoutManifestEntry,
  type CheckoutObservation,
  type CheckoutPath,
} from './schemas/checkout-observation';

/** Engine-private home of manifests inside a run's artifacts directory. */
const MANIFEST_DIR = '.archon/checkout';
/** Keep argv well under platform limits when hashing many dirty paths at once. */
const HASH_BATCH_SIZE = 200;
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

interface GitResult {
  code: number;
  stdout: Buffer;
}

const REPOSITORY_SELECTORS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
]);

/**
 * Run git read-only. Repository-selecting variables are dropped so the observation reads
 * the checkout at `cwd`, not whatever repository the engine process happened to inherit.
 */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !REPOSITORY_SELECTORS.has(key))
    ),
    GIT_OPTIONAL_LOCKS: '0',
  };
  return new Promise(resolve => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      {
        cwd,
        env,
        encoding: 'buffer',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout) => {
        // A numeric code is git's exit status; anything else (a spawn error, a timeout
        // kill) is a failed read, never success.
        const exit: unknown = error?.code;
        resolve({ code: error === null ? 0 : typeof exit === 'number' ? exit : -1, stdout });
      }
    );
  });
}

function text(buffer: Buffer): string {
  return buffer.toString('utf8').trim();
}

/** The checkout's own marker walk: a directory with no `.git` in any ancestor is not Git. */
function hasGitMarker(cwd: string): boolean {
  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    dir = cwd;
  }
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * The marker walk run inside a container. It answers on stdout rather than through its
 * exit status, because `docker exec` exits 1 for its own failures too ("No such
 * container"), which would be indistinguishable from "no .git found".
 */
const CONTAINER_MARKER_PROBE =
  'd=$(pwd -P); while :; do if [ -e "$d/.git" ]; then echo marker; exit 0; fi; if [ "$d" = / ]; then echo none; exit 0; fi; d=$(dirname "$d"); done';

export type ContainerProbe = 'marker' | 'none' | 'failed';

/** Only a successful exit with exactly one of the probe's own answers is an answer. */
export function readContainerProbe(exitCode: number, stdout: string): ContainerProbe {
  if (exitCode !== 0) return 'failed';
  const answer = stdout.trim();
  return answer === 'marker' || answer === 'none' ? answer : 'failed';
}

function probeContainerMarker(
  cwd: string,
  execContext: Extract<ExecutionContext, { kind: 'container' }>
): Promise<ContainerProbe> {
  const args = ['exec', '-w', cwd];
  if (execContext.execUser) args.push('-u', execContext.execUser);
  args.push(execContext.containerId, 'sh', '-c', CONTAINER_MARKER_PROBE);
  return new Promise(resolve => {
    execFile('docker', args, { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const exit: unknown = error?.code;
      resolve(
        readContainerProbe(error === null ? 0 : typeof exit === 'number' ? exit : -1, stdout)
      );
    });
  });
}

/** Encode raw path bytes: UTF-8 text when lossless, base64 otherwise. */
function encodePath(raw: Buffer): CheckoutPath {
  const decoded = raw.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(raw) ? decoded : { base64: raw.toString('base64') };
}

/** Raw bytes of an encoded path, the sort and identity key for manifest entries. */
export function checkoutPathBytes(path: CheckoutPath): Buffer {
  return typeof path === 'string' ? Buffer.from(path, 'utf8') : Buffer.from(path.base64, 'base64');
}

interface StatusEntry {
  raw: Buffer;
  /** Worktree mode from porcelain v2; `undefined` for an untracked path. */
  worktreeMode?: string;
  submodule?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

/**
 * Parse `git status --porcelain=v2 -z --no-renames`. Records are NUL-terminated and the
 * path is the final field, so a path containing spaces or newlines stays one record.
 */
function parseStatus(output: Buffer): StatusEntry[] {
  const entries: StatusEntry[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    const record = output.subarray(start, end === -1 ? output.length : end);
    start = end === -1 ? output.length : end + 1;
    if (record.length === 0) continue;
    const kind = String.fromCharCode(record[0] ?? 0);
    if (kind === '?') {
      entries.push({ raw: record.subarray(2), staged: false, unstaged: false, untracked: true });
      continue;
    }
    // Space-separated header fields precede the path, counting the record type: 8 for an
    // ordinary record (`1 XY sub mH mI mW hH hI`), 10 for an unmerged one
    // (`u XY sub m1 m2 m3 mW h1 h2 h3`). `mW` is the worktree mode in both.
    const fieldCount = kind === '1' ? 8 : kind === 'u' ? 10 : -1;
    if (fieldCount === -1) {
      throw new Error(`unexpected git status record type '${kind}'`);
    }
    let offset = 0;
    const fields: string[] = [];
    for (let i = 0; i < fieldCount; i++) {
      const space = record.indexOf(0x20, offset);
      if (space === -1) throw new Error('truncated git status record');
      fields.push(record.subarray(offset, space).toString('latin1'));
      offset = space + 1;
    }
    const xy = fields[1] ?? '..';
    entries.push({
      raw: record.subarray(offset),
      worktreeMode: kind === '1' ? fields[5] : fields[6],
      submodule: fields[2],
      staged: !xy.startsWith('.'),
      unstaged: xy.charAt(1) !== '.',
      untracked: false,
    });
  }
  return entries;
}

type ObjectFormat = CheckoutManifest['objectFormat'];

/** Git's object id for bytes stored as a blob, computed without touching the object store. */
function blobId(format: ObjectFormat, bytes: Buffer): string {
  return createHash(format)
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
}

interface StatSignature {
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
}

async function statSignature(path: string): Promise<StatSignature | undefined> {
  try {
    const s = await lstat(path);
    return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, mode: s.mode };
  } catch {
    return undefined;
  }
}

function sameSignature(a: StatSignature | undefined, b: StatSignature | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode;
}

/** A sampled observation whose dirty manifest, if any, has not yet been written. */
export type CheckoutSample =
  | { observation: Exclude<CheckoutObservation, { kind: 'git' }> }
  | {
      observation: Omit<Extract<CheckoutObservation, { kind: 'git' }>, 'worktree'>;
      worktree:
        | { status: 'clean' }
        | {
            status: 'dirty';
            staged: number;
            unstaged: number;
            untracked: number;
            manifest: CheckoutManifest;
          };
    };

const FAILED = (sampledAt: string): CheckoutSample => ({
  observation: { kind: 'unavailable', sampledAt, reason: 'git_failed' },
});

async function readHead(
  top: string
): Promise<{ commit: string | null; tree: string | null } | undefined> {
  const head = await runGit(top, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  if (head.code === 0) {
    const commit = text(head.stdout);
    const tree = await runGit(top, ['rev-parse', '-q', '--verify', 'HEAD^{tree}']);
    return tree.code === 0 ? { commit, tree: text(tree.stdout) } : undefined;
  }
  // Unborn only when HEAD names a branch that does not exist yet; any other failure is a
  // broken read, not an empty repository.
  const symbolic = await runGit(top, ['symbolic-ref', '-q', 'HEAD']);
  if (symbolic.code !== 0) return undefined;
  const ref = await runGit(top, ['show-ref', '--verify', '-q', text(symbolic.stdout)]);
  return ref.code === 1 ? { commit: null, tree: null } : undefined;
}

/**
 * Sample the checkout at `cwd` through the execution backend. Container runs cannot yet be
 * read from inside the container, so a container that holds a Git checkout is reported
 * `unsupported_backend` rather than substituting the host's view of the same path.
 */
export async function sampleCheckout(
  cwd: string,
  execContext: ExecutionContext,
  now: () => Date = () => new Date()
): Promise<CheckoutSample> {
  const sampledAt = now().toISOString();
  if (execContext.kind === 'container') {
    const probe = await probeContainerMarker(cwd, execContext);
    if (probe === 'none') return { observation: { kind: 'not_git', sampledAt } };
    return {
      observation: {
        kind: 'unavailable',
        sampledAt,
        reason: probe === 'marker' ? 'unsupported_backend' : 'probe_failed',
      },
    };
  }
  if (!hasGitMarker(cwd)) return { observation: { kind: 'not_git', sampledAt } };

  const topResult = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (topResult.code !== 0) return FAILED(sampledAt);
  const top = text(topResult.stdout);
  const formatResult = await runGit(top, ['rev-parse', '--show-object-format']);
  const objectFormat = text(formatResult.stdout);
  if (formatResult.code !== 0 || (objectFormat !== 'sha1' && objectFormat !== 'sha256')) {
    return FAILED(sampledAt);
  }
  const head = await readHead(top);
  if (head === undefined) return FAILED(sampledAt);

  const statusArgs = [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--no-renames',
    '--ignore-submodules=none',
  ];
  const before = await runGit(top, statusArgs);
  if (before.code !== 0) return FAILED(sampledAt);
  let statusEntries: StatusEntry[];
  try {
    statusEntries = parseStatus(before.stdout);
  } catch {
    return FAILED(sampledAt);
  }
  const observation = { kind: 'git' as const, sampledAt, ...head };
  if (statusEntries.length === 0) return { observation, worktree: { status: 'clean' } };

  const fileModeResult = await runGit(top, ['config', '--type=bool', '--get', 'core.fileMode']);
  const honorsExecutableBit = fileModeResult.code !== 0 || text(fileModeResult.stdout) !== 'false';

  // One entry per path. `git rm --cached` yields two records for one file: a tracked
  // record whose worktree mode is 000000 (the index no longer tracks it) and an untracked
  // record (it is still on disk). The file exists, so the untracked record describes it;
  // otherwise the tracked record's worktree mode is the authority.
  const byPath = new Map<string, StatusEntry>();
  const authority = (entry: StatusEntry): number =>
    entry.untracked ? 1 : entry.worktreeMode === '000000' ? 0 : 2;
  for (const entry of statusEntries) {
    const key = entry.raw.toString('base64');
    const existing = byPath.get(key);
    if (existing === undefined || authority(entry) > authority(existing)) byPath.set(key, entry);
  }

  const entries: CheckoutManifestEntry[] = [];
  const toHash: { entry: StatusEntry; mode: '100644' | '100755'; signature: StatSignature }[] = [];
  for (const entry of byPath.values()) {
    const path = encodePath(entry.raw);
    const absolute = join(top, entry.raw.toString('utf8'));
    if (typeof path !== 'string') {
      // Hashing goes through argv, which cannot carry non-UTF-8 bytes faithfully.
      entries.push({ path, kind: 'incomplete', reason: 'unreadable' });
      continue;
    }
    if (entry.worktreeMode === '000000') {
      entries.push({ path, kind: 'absent' });
      continue;
    }
    if (entry.worktreeMode === '160000' || entry.submodule?.startsWith('S') === true) {
      const flags = entry.submodule ?? 'S...';
      if (flags[2] === 'M' || flags[3] === 'U') {
        entries.push({ path, kind: 'incomplete', reason: 'dirty_submodule' });
        continue;
      }
      // An unpopulated submodule directory has no `.git`, so discovery from it finds the
      // superproject. An empty prefix proves the directory is its own repository's top.
      const prefix = await runGit(absolute, ['rev-parse', '--show-prefix']);
      const sub =
        prefix.code === 0 && text(prefix.stdout) === ''
          ? await runGit(absolute, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])
          : undefined;
      entries.push(
        sub?.code === 0
          ? { path, kind: 'gitlink', mode: '160000', commit: text(sub.stdout) }
          : { path, kind: 'incomplete', reason: 'unreadable' }
      );
      continue;
    }
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      entries.push({
        path,
        kind: 'incomplete',
        reason: code === 'ENOENT' ? 'changed_while_observing' : 'unreadable',
      });
      continue;
    }
    const signature = {
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mode: stats.mode,
    };
    const isSymlink =
      entry.worktreeMode === '120000' || (entry.untracked && stats.isSymbolicLink());
    if (isSymlink) {
      try {
        const target = await readlink(absolute, { encoding: 'buffer' });
        if (!sameSignature(signature, await statSignature(absolute))) {
          entries.push({ path, kind: 'incomplete', reason: 'changed_while_observing' });
        } else {
          entries.push({
            path,
            kind: 'symlink',
            mode: '120000',
            blob: blobId(objectFormat, target),
          });
        }
      } catch {
        entries.push({ path, kind: 'incomplete', reason: 'unreadable' });
      }
      continue;
    }
    if (!stats.isFile()) {
      entries.push({ path, kind: 'incomplete', reason: 'special_file' });
      continue;
    }
    const mode: '100644' | '100755' = entry.untracked
      ? honorsExecutableBit && (stats.mode & 0o111) !== 0
        ? '100755'
        : '100644'
      : entry.worktreeMode === '100755'
        ? '100755'
        : '100644';
    toHash.push({ entry, mode, signature });
  }

  // `hash-object` applies the path's clean filter and CRLF conversion, so the id equals
  // the blob Git would commit for these bytes. A batch that fails is retried per path to
  // name exactly which files could not be identified.
  const hashOne = async (paths: string[]): Promise<string[] | undefined> => {
    const result = await runGit(top, ['hash-object', '--', ...paths]);
    if (result.code !== 0) return undefined;
    const ids = result.stdout.toString('utf8').split('\n').filter(Boolean);
    return ids.length === paths.length ? ids : undefined;
  };
  for (let i = 0; i < toHash.length; i += HASH_BATCH_SIZE) {
    const batch = toHash.slice(i, i + HASH_BATCH_SIZE);
    const names = batch.map(item => item.entry.raw.toString('utf8'));
    const ids =
      (await hashOne(names)) ??
      (await Promise.all(names.map(async name => (await hashOne([name]))?.[0])));
    for (const [index, item] of batch.entries()) {
      const path = names[index] ?? '';
      const id = ids[index];
      if (id === undefined) {
        entries.push({ path, kind: 'incomplete', reason: 'unreadable' });
        continue;
      }
      const unchanged = sameSignature(item.signature, await statSignature(join(top, path)));
      entries.push(
        unchanged
          ? { path, kind: 'file', mode: item.mode, blob: id }
          : { path, kind: 'incomplete', reason: 'changed_while_observing' }
      );
    }
  }

  // A checkout that changed while it was being read cannot be described as one instant.
  const after = await runGit(top, statusArgs);
  if (after.code !== 0) return FAILED(sampledAt);
  if (!after.stdout.equals(before.stdout)) {
    const beforeRecords = new Set(splitRecords(before.stdout));
    const afterRecords = new Set(splitRecords(after.stdout));
    const moved = [
      ...[...beforeRecords].filter(record => !afterRecords.has(record)),
      ...[...afterRecords].filter(record => !beforeRecords.has(record)),
    ];
    let changedEntries: StatusEntry[];
    try {
      changedEntries = parseStatus(
        Buffer.concat(moved.flatMap(record => [Buffer.from(record, 'base64'), Buffer.from([0])]))
      );
    } catch {
      return FAILED(sampledAt);
    }
    const changed = new Set(changedEntries.map(entry => entry.raw.toString('base64')));
    for (const [index, existing] of entries.entries()) {
      if (changed.delete(checkoutPathBytes(existing.path).toString('base64'))) {
        entries[index] = {
          path: existing.path,
          kind: 'incomplete',
          reason: 'changed_while_observing',
        };
      }
    }
    for (const key of changed) {
      entries.push({
        path: encodePath(Buffer.from(key, 'base64')),
        kind: 'incomplete',
        reason: 'changed_while_observing',
      });
    }
  }

  entries.sort((a, b) => Buffer.compare(checkoutPathBytes(a.path), checkoutPathBytes(b.path)));
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const entry of statusEntries) {
    if (entry.staged) staged++;
    if (entry.unstaged) unstaged++;
    if (entry.untracked) untracked++;
  }
  return {
    observation,
    worktree: {
      status: 'dirty',
      staged,
      unstaged,
      untracked,
      manifest: {
        version: CHECKOUT_MANIFEST_VERSION,
        objectFormat,
        commit: head.commit,
        entries,
      },
    },
  };
}

function splitRecords(output: Buffer): string[] {
  const records: string[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    const stop = end === -1 ? output.length : end;
    if (stop > start) records.push(output.subarray(start, stop).toString('base64'));
    start = stop + 1;
  }
  return records;
}

/**
 * Persist a sample's manifest under the run's artifacts and return the typed observation.
 * The file is content-addressed and written before the observation that points at it
 * exists, so a published pointer always names a complete file.
 */
export async function recordCheckoutSample(
  sample: CheckoutSample,
  run: { runId: string; artifactsDir: string },
  extra: { cutFromCommit?: string } = {}
): Promise<CheckoutObservation> {
  if (!('worktree' in sample)) return sample.observation;
  const base = {
    ...sample.observation,
    ...(extra.cutFromCommit !== undefined ? { cutFromCommit: extra.cutFromCommit } : {}),
  };
  if (sample.worktree.status === 'clean') return { ...base, worktree: { status: 'clean' } };
  const { manifest, staged, unstaged, untracked } = sample.worktree;
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const relativePath = `${MANIFEST_DIR}/${sha256}.json`;
  const absolute = join(run.artifactsDir, ...relativePath.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, bytes, { flag: 'wx' });
  } catch (error) {
    // Same digest means same bytes: an existing file is this manifest already.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return {
    ...base,
    worktree: {
      status: 'dirty',
      content: manifest.entries.some(entry => entry.kind === 'incomplete')
        ? 'incomplete'
        : 'complete',
      staged,
      unstaged,
      untracked,
      manifest: {
        pointer: { type: ARTIFACT_POINTER_TYPE, run_id: run.runId, path: relativePath },
        sha256,
        entries: manifest.entries.length,
      },
    },
  };
}

/** Sample and record in one step, for node starts where the artifacts directory exists. */
export async function observeCheckout(
  cwd: string,
  execContext: ExecutionContext,
  run: { runId: string; artifactsDir: string }
): Promise<CheckoutObservation> {
  return recordCheckoutSample(await sampleCheckout(cwd, execContext), run);
}
