/**
 * One enumeration of a project's definition paths, used for every layer a run's
 * definitions are composed from: the base commit, the operator's checkout, a run's own
 * checkout. A view maps each file a definition path resolves to, as the capture walker
 * would find it, to the content git stores for it.
 *
 * Both kinds of view resolve the same things the same way, so two views can be compared
 * path by path:
 * - a symlink whose target is in the repository is followed, through any number of links,
 *   and its files are listed under the link's path;
 * - a symlink that leaves the repository, or names nothing, stays one link entry;
 * - an initialized submodule is descended into: at a commit, at the commit the
 *   superproject records for it; in a working tree, as checked out. An uninitialized one
 *   is empty.
 *
 * A commit view reads git objects, so archive attributes such as `export-ignore` never
 * drop a committed file. A working-tree view reads the checkout without writing to it.
 */
import { spawn } from 'child_process';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'path';
import { execFileAsync } from '@archon/git';

export type ViewEntry =
  | { kind: 'file'; oid: string; mode: string; repo: string; real?: string }
  | { kind: 'link'; target: string };

/** Paths relative to the repository top, with `/` separators. */
export type DefinitionView = Map<string, ViewEntry>;

export type ViewChange = 'modified' | 'added' | 'deleted';

/** A view could not be read: a submodule lacks a commit the definitions need. */
export class DefinitionViewError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DefinitionViewError';
  }
}

/** How many links one path may pass through before it is left as a link. */
const MAX_LINK_HOPS = 8;

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    ...(input !== undefined ? { input } : {}),
  });
  return stdout;
}

const nulList = (stdout: string): string[] => stdout.split('\0').filter(entry => entry !== '');

const toPosix = (path: string): string => path.split(sep).join('/');

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

async function lsTree(
  repo: string,
  commit: string,
  paths: readonly string[],
  recursive: boolean
): Promise<TreeEntry[]> {
  if (paths.length === 0) return [];
  const listed = nulList(
    await git(repo, ['ls-tree', '-z', ...(recursive ? ['-r'] : []), commit, '--', ...paths])
  );
  return listed.map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
}

/** The bytes of each blob in `repo`, through one `git cat-file --batch`. */
export function readBlobs(repo: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  if (oids.length === 0) return Promise.resolve(new Map());
  return new Promise((done, fail) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', fail);
    child.on('close', code => {
      if (code !== 0) {
        fail(new Error(`git cat-file failed: ${Buffer.concat(err).toString('utf8')}`));
        return;
      }
      const data = Buffer.concat(out);
      const blobs = new Map<string, Buffer>();
      let at = 0;
      while (at < data.length) {
        const end = data.indexOf(0x0a, at);
        const [oid, type, size] = data.subarray(at, end).toString('utf8').split(' ');
        if (type === 'missing' || size === undefined) {
          fail(new Error(`git object ${oid} is missing`));
          return;
        }
        const start = end + 1;
        blobs.set(oid, data.subarray(start, start + Number(size)));
        at = start + Number(size) + 1;
      }
      done(blobs);
    });
    child.stdin.end(`${oids.join('\n')}\n`);
  });
}

/** Whether `path` lies inside `root` (both absolute). */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The checkout of the submodule at `path` in `top`, or undefined when it is not
 * initialized. One that lacks a commit refuses, naming it.
 */
async function submoduleRepo(
  top: string,
  path: string,
  commit: string
): Promise<string | undefined> {
  const sub = join(top, path);
  let subTop: string;
  try {
    subTop = (await git(sub, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return undefined;
  }
  if (resolve(subTop) === resolve(top)) return undefined;
  try {
    await git(sub, ['cat-file', '-e', `${commit}^{commit}`]);
  } catch (error) {
    throw new DefinitionViewError(
      `The submodule at ${path} lacks commit ${commit.slice(0, 12)}, which this run's definitions ` +
        'need. Fetch it in the submodule (git submodule update), then start again.',
      { cause: error }
    );
  }
  return sub;
}

/**
 * The view of `paths` (pathspecs relative to `top`) at `commit` in the repository `top`.
 */
export async function commitView(
  top: string,
  commit: string,
  paths: readonly string[]
): Promise<DefinitionView> {
  const view: DefinitionView = new Map();
  const add = async (entries: TreeEntry[], at: (path: string) => string, hops: number) => {
    for (const entry of entries) {
      const path = at(entry.path);
      if (entry.mode === '120000') await follow(entry, path, hops);
      else if (entry.mode === '160000') {
        const sub = await submoduleRepo(top, entry.path, entry.oid);
        if (sub === undefined) continue;
        for (const [inner, found] of await commitView(sub, entry.oid, ['.']))
          view.set(`${path}/${inner}`, found);
      } else if (entry.type === 'blob')
        view.set(path, { kind: 'file', oid: entry.oid, mode: entry.mode, repo: top });
    }
  };
  const follow = async (link: TreeEntry, path: string, hops: number) => {
    const text = (await readBlobs(top, [link.oid])).get(link.oid)?.toString('utf8') ?? '';
    const target = posix.normalize(posix.join(posix.dirname(link.path), text));
    const absolute = resolve(top, dirname(link.path), text);
    const inRepo = !posix.isAbsolute(text) && target !== '..' && !target.startsWith('../');
    const found =
      inRepo && hops < MAX_LINK_HOPS
        ? (await lsTree(top, commit, [target], false)).find(entry => entry.path === target)
        : undefined;
    if (!found) {
      view.set(path, { kind: 'link', target: absolute });
      return;
    }
    const under = (inner: string) =>
      inner === target ? path : `${path}${inner.slice(target.length)}`;
    await add(
      found.type === 'tree' ? await lsTree(top, commit, [target], true) : [found],
      under,
      hops + 1
    );
  };
  await add(await lsTree(top, commit, paths, true), path => path, 0);
  return view;
}

/**
 * The view of `paths` in the working tree at `top`, as the capture walker reads it:
 * links into the repository are followed, links out of it or naming nothing stay links,
 * `.git` is skipped. Content ids are git's, under the checkout's filters, so they compare
 * with a commit view's.
 */
export async function worktreeView(top: string, paths: readonly string[]): Promise<DefinitionView> {
  const view: DefinitionView = new Map();
  const realTop = await realpath(top);
  const files: { path: string; real: string; mode: string }[] = [];
  const walk = async (abs: string, path: string, ancestors: ReadonlySet<string>) => {
    const found = await resolveEntry(abs, realTop, ancestors);
    if (found.kind === 'link') view.set(path, { kind: 'link', target: found.target });
    else if (found.kind === 'dir')
      await walkDir(found.real, path, new Set([...ancestors, found.real]));
    else if (found.kind === 'file') files.push({ path, real: found.real, mode: found.mode });
  };
  const walkDir = async (abs: string, path: string, ancestors: ReadonlySet<string>) => {
    for (const entry of await readdir(abs)) {
      if (entry === '.git') continue;
      await walk(join(abs, entry), `${path}/${entry}`, ancestors);
    }
  };
  for (const path of paths) await walk(join(top, path), toPosix(path), new Set([realTop]));
  if (files.length > 0) {
    const oids = (
      await git(top, ['hash-object', '--stdin-paths'], `${files.map(f => f.real).join('\n')}\n`)
    )
      .trim()
      .split('\n');
    files.forEach((file, index) =>
      view.set(file.path, {
        kind: 'file',
        oid: oids[index],
        mode: file.mode,
        repo: top,
        real: file.real,
      })
    );
  }
  return view;
}

type Resolved =
  | { kind: 'missing' }
  | { kind: 'link'; target: string }
  | { kind: 'dir'; real: string }
  | { kind: 'file'; real: string; mode: string };

const modeOf = (mode: number): string => (mode & 0o111 ? '100755' : '100644');

/**
 * What one working-tree path is to a view: a link into the repository is followed, one
 * that leaves it, loops back above itself or names nothing stays a link.
 */
async function resolveEntry(
  abs: string,
  realTop: string,
  ancestors: ReadonlySet<string>
): Promise<Resolved> {
  let info;
  try {
    info = await lstat(abs);
  } catch {
    return { kind: 'missing' };
  }
  if (!info.isSymbolicLink()) {
    if (info.isDirectory()) return { kind: 'dir', real: await realpath(abs) };
    return info.isFile()
      ? { kind: 'file', real: abs, mode: modeOf(info.mode) }
      : { kind: 'missing' };
  }
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return { kind: 'link', target: resolve(dirname(abs), await readlink(abs)) };
  }
  if (!within(realTop, real) || ancestors.has(real)) return { kind: 'link', target: real };
  const target = await lstat(real);
  if (target.isDirectory()) return { kind: 'dir', real };
  return target.isFile() ? { kind: 'file', real, mode: modeOf(target.mode) } : { kind: 'missing' };
}

/** Two entries hold the same content. */
export function sameEntry(a: ViewEntry | undefined, b: ViewEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'link' || b.kind === 'link')
    return a.kind === 'link' && b.kind === 'link' && a.target === b.target;
  return a.oid === b.oid;
}

/** Each path whose entry differs between `from` and `to`, sorted. */
export function changedPaths(
  from: DefinitionView,
  to: DefinitionView
): { path: string; change: ViewChange }[] {
  const changes: { path: string; change: ViewChange }[] = [];
  for (const path of new Set([...from.keys(), ...to.keys()])) {
    const before = from.get(path);
    const after = to.get(path);
    if (sameEntry(before, after)) continue;
    changes.push({
      path,
      change: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
    });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Write `view`'s entries under `tree`. File entries from a working tree are copied. */
export async function writeView(view: DefinitionView, tree: string): Promise<void> {
  const byRepo = new Map<string, Set<string>>();
  for (const entry of view.values())
    if (entry.kind === 'file' && entry.real === undefined)
      byRepo.set(entry.repo, (byRepo.get(entry.repo) ?? new Set()).add(entry.oid));
  const blobs = new Map<string, Buffer>();
  for (const [repo, oids] of byRepo)
    for (const [oid, bytes] of await readBlobs(repo, [...oids])) blobs.set(oid, bytes);
  for (const [path, entry] of view) await writeEntry(tree, path, entry, blobs);
}

/** Lay `entry` (or its absence) at `path` under `tree`, replacing what is there. */
export async function writeEntry(
  tree: string,
  path: string,
  entry: ViewEntry | undefined,
  blobs: ReadonlyMap<string, Buffer> = new Map()
): Promise<void> {
  const target = join(tree, path);
  await rm(target, { recursive: true, force: true });
  if (entry === undefined) return;
  await mkdir(dirname(target), { recursive: true });
  if (entry.kind === 'link') {
    await symlink(entry.target, target);
    return;
  }
  const bytes =
    entry.real !== undefined
      ? await readFile(entry.real)
      : (blobs.get(entry.oid) ??
        (await readBlobs(entry.repo, [entry.oid])).get(entry.oid) ??
        Buffer.alloc(0));
  await writeFile(target, bytes);
  if (entry.mode === '100755') await chmod(target, 0o755);
}
