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
import { execFileAsync } from '@archon/git';
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
/**
 * Samples taken while HEAD keeps moving between the commit read and `git status` before
 * the observation gives up as unavailable.
 */
const HEAD_READ_ATTEMPTS = 3;
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
function runGit(cwd: string, args: string[], input?: Buffer): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !REPOSITORY_SELECTORS.has(key))
    ),
    GIT_OPTIONAL_LOCKS: '0',
  };
  return new Promise(resolve => {
    const child = execFile(
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
    if (input !== undefined && child.stdin !== null) {
      // Git exiting before it reads all input surfaces as EPIPE here; its exit status
      // already reports that failure through the callback.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }
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
export const CONTAINER_MARKER_PROBE =
  'd=$(pwd -P); while :; do if [ -e "$d/.git" ]; then echo marker; exit 0; fi; if [ "$d" = / ]; then echo none; exit 0; fi; d=$(dirname "$d"); done';

type ContainerProbe = 'marker' | 'none' | 'failed';

/**
 * Runs through `@archon/git`'s `execFileAsync`, like the executor's other `docker exec`
 * calls, so tests can answer for a container that does not exist instead of spawning
 * `docker`.
 */
async function probeContainerMarker(
  cwd: string,
  execContext: Extract<ExecutionContext, { kind: 'container' }>
): Promise<ContainerProbe> {
  const args = ['exec', '-w', cwd];
  if (execContext.execUser) args.push('-u', execContext.execUser);
  args.push(execContext.containerId, 'sh', '-c', CONTAINER_MARKER_PROBE);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('docker', args, { timeout: GIT_TIMEOUT_MS }));
  } catch {
    // A non-zero exit, a spawn error, or a timeout kill is a failed probe, never an answer.
    return 'failed';
  }
  // Only a successful exit with exactly one of the probe's own answers is an answer.
  const answer = stdout.trim();
  return answer === 'marker' || answer === 'none' ? answer : 'failed';
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

interface Status {
  /**
   * The commit this status compared the index against, from its `# branch.oid` header:
   * null on an unborn branch, undefined when the header is missing.
   */
  commit: string | null | undefined;
  entries: StatusEntry[];
}

const BRANCH_OID_HEADER = '# branch.oid ';

/**
 * Parse `git status --porcelain=v2 -z --branch --no-renames`. Records are NUL-terminated
 * and the path is the final field, so a path containing spaces or newlines stays one
 * record. Header records start with `#` and name no path.
 */
function parseStatus(output: Buffer): Status {
  const entries: StatusEntry[] = [];
  let commit: string | null | undefined;
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    const record = output.subarray(start, end === -1 ? output.length : end);
    start = end === -1 ? output.length : end + 1;
    if (record.length === 0) continue;
    const kind = String.fromCharCode(record[0] ?? 0);
    if (kind === '#') {
      const header = record.toString('latin1');
      if (header.startsWith(BRANCH_OID_HEADER)) {
        const oid = header.slice(BRANCH_OID_HEADER.length);
        commit = oid === '(initial)' ? null : oid;
      }
      continue;
    }
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
  return { commit, entries };
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

interface Head {
  top: string;
  objectFormat: ObjectFormat;
  /** Null on an unborn branch. */
  commit: string | null;
}

/**
 * Split `rev-parse` output that answers `--show-toplevel` first and then `count` one-word
 * answers. The toplevel is the only answer that can itself contain a newline.
 */
function splitTopLevel(stdout: Buffer, count: number): { top: string; rest: string[] } | undefined {
  const lines = stdout.toString('utf8').replace(/\n$/, '').split('\n');
  if (lines.length <= count) return undefined;
  return { top: lines.slice(0, -count).join('\n'), rest: lines.slice(-count) };
}

function isObjectFormat(value: string | undefined): value is ObjectFormat {
  return value === 'sha1' || value === 'sha256';
}

/** The checkout's toplevel, object format, and HEAD commit, in one Git call when HEAD is born. */
async function readHead(cwd: string): Promise<Head | undefined> {
  const withCommit = await runGit(cwd, [
    'rev-parse',
    '--show-toplevel',
    '--show-object-format',
    '--verify',
    '-q',
    'HEAD^{commit}',
  ]);
  if (withCommit.code === 0) {
    const read = splitTopLevel(withCommit.stdout, 2);
    const [objectFormat, commit] = read?.rest ?? [];
    if (read === undefined || !isObjectFormat(objectFormat) || commit === undefined) {
      return undefined;
    }
    return { top: read.top, objectFormat, commit };
  }
  const withoutCommit = await runGit(cwd, ['rev-parse', '--show-toplevel', '--show-object-format']);
  const read = withoutCommit.code === 0 ? splitTopLevel(withoutCommit.stdout, 1) : undefined;
  const objectFormat = read?.rest[0];
  if (read === undefined || !isObjectFormat(objectFormat)) return undefined;
  // Unborn only when HEAD names a branch that does not exist yet; any other failure is a
  // broken read, not an empty repository.
  const symbolic = await runGit(read.top, ['symbolic-ref', '-q', 'HEAD']);
  if (symbolic.code !== 0) return undefined;
  const ref = await runGit(read.top, ['show-ref', '--verify', '-q', text(symbolic.stdout)]);
  return ref.code === 1 ? { top: read.top, objectFormat, commit: null } : undefined;
}

/**
 * C-quote a path for `hash-object --stdin-paths`, which unquotes every line that starts
 * with `"`. Quoting every path keeps a name that starts with `"` or holds a newline from
 * being read as a different file.
 */
function stdinPath(path: string): string {
  return `"${path.replace(/[\\"\n]/g, char => (char === '\n' ? '\\n' : `\\${char}`))}"\n`;
}

const STATUS_ARGS = [
  'status',
  '--porcelain=v2',
  '-z',
  '--branch',
  '--no-ahead-behind',
  '--untracked-files=all',
  '--no-renames',
  '--ignore-submodules=none',
];

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

  for (let attempt = 0; attempt < HEAD_READ_ATTEMPTS; attempt++) {
    const sample = await sampleGit(cwd, sampledAt);
    if (sample !== 'head_moved') return sample;
  }
  return FAILED(sampledAt);
}

/**
 * One sample of a host Git checkout, or `head_moved` when HEAD moved between reading the
 * commit and `git status`, so the status would describe a different commit than the one
 * read.
 */
async function sampleGit(cwd: string, sampledAt: string): Promise<CheckoutSample | 'head_moved'> {
  const head = await readHead(cwd);
  if (head === undefined) return FAILED(sampledAt);
  const { top, objectFormat, commit } = head;
  // The tree is read from the commit id, not from HEAD, so it cannot belong to another
  // commit. It runs alongside status.
  const treeRead =
    commit === null ? undefined : runGit(top, ['rev-parse', '-q', '--verify', `${commit}^{tree}`]);
  const before = await runGit(top, STATUS_ARGS);
  const treeResult = await treeRead;
  if (before.code !== 0) return FAILED(sampledAt);
  let status: Status;
  try {
    status = parseStatus(before.stdout);
  } catch {
    return FAILED(sampledAt);
  }
  if (status.commit === undefined) return FAILED(sampledAt);
  // Status diffs the index against HEAD as it reads HEAD itself, and a concurrent commit,
  // reset, or checkout can move HEAD after `rev-parse` read it. Its header names the
  // commit it read; labelling its records with any other commit is a false observation.
  // Git resolves HEAD for the header and for the diff separately inside the one status
  // process, so a move in that window is not caught here.
  if (status.commit !== commit) return 'head_moved';
  let tree: string | null = null;
  if (commit !== null) {
    if (treeResult?.code !== 0) return FAILED(sampledAt);
    tree = text(treeResult.stdout);
  }
  const statusEntries = status.entries;
  const observation = { kind: 'git' as const, sampledAt, commit, tree };
  if (statusEntries.length === 0) return { observation, worktree: { status: 'clean' } };

  // `core.fileMode` decides only an untracked file's mode, so a checkout without untracked
  // files never reads it.
  let honorsExecutableBit = true;
  if (statusEntries.some(entry => entry.untracked)) {
    const fileMode = await runGit(top, ['config', '--type=bool', '--get', 'core.fileMode']);
    honorsExecutableBit = fileMode.code !== 0 || text(fileMode.stdout) !== 'false';
  }

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
      // The path reaches `lstat` and `hash-object` as text, which cannot carry non-UTF-8
      // bytes faithfully.
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

  // `hash-object` applies each path's clean filter and CRLF conversion, so the id equals
  // the blob Git would commit for these bytes. Paths go through stdin, which has no length
  // limit. Git prints ids in input order and exits at the first path it cannot read, so
  // that path is the one after the printed ids; it is named unreadable and the rest are
  // hashed again. Output that cannot be matched to paths identifies none of them.
  const names = toHash.map(item => item.entry.raw.toString('utf8'));
  const ids: (string | undefined)[] = [];
  while (ids.length < names.length) {
    const pending = names.slice(ids.length);
    const result = await runGit(
      top,
      ['hash-object', '--stdin-paths'],
      Buffer.from(pending.map(stdinPath).join(''), 'utf8')
    );
    const printed = result.stdout.toString('utf8').split('\n').filter(Boolean);
    if (result.code === 0 && printed.length === pending.length) {
      ids.push(...printed);
    } else if (result.code > 0 && printed.length < pending.length) {
      ids.push(...printed, undefined);
    } else {
      break;
    }
  }
  for (const [index, item] of toHash.entries()) {
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

  // A checkout that changed while it was being read cannot be described as one instant.
  const after = await runGit(top, STATUS_ARGS);
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
      ).entries;
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
        commit,
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
