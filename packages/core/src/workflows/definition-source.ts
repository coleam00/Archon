/**
 * A run's definitions: the project's workflows, commands, scripts, in-repository packs
 * and `.archon/config.yaml` as they are on the base branch fetched now, with the files
 * uncommitted in the operator's checkout laid on top.
 *
 * The two layers are composed into a temporary directory that only feeds the run's
 * capture; nothing is written into the run's checkout or the operator's. The operator's
 * checkout is only read: the fetch moves the remote-tracking ref and nothing else.
 * Changes committed on the checkout's own branch are not a layer: only what is
 * uncommitted is laid on the base.
 */
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { execFileAsync, fetchWithRetry, getDefaultBranch, toRepoPath } from '@archon/git';
import { resolveWorktreeBase } from '@archon/isolation';
import { getArchonTempPath } from '@archon/paths';
import type { WorkflowDeps } from '@archon/workflows/deps';
import type { BaseRunDefinitions, RunDefinitions } from '@archon/workflows/schemas/run-metadata';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { projectSourceDirs } from '@archon/workflows/workflow-source';
import { loadRepoConfig } from '../config/config-loader';
import type { Codebase } from '../schemas/codebase';

const PROJECT_CONFIG = '.archon/config.yaml';
const FETCH_TIMEOUT_MS = 60_000;

/** A start refused because its definitions cannot be composed; the message says why. */
export class DefinitionSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DefinitionSourceError';
  }
}

export interface LayeredDefinitionsInput {
  /** The operator's checkout. Read, never changed. */
  checkout: string;
  /** The registered checkout, whose `worktree.remote` and `worktree.baseBranch` apply. */
  repoPath?: string;
  /** `--base`, a binding's base, or the item's landing branch. */
  baseOverride?: string;
  /** The registered project's default branch. */
  defaultBranch?: string;
}

export interface ComposedDefinitions {
  /** A project root holding the composed definitions; removed when `use` returns. */
  root: string;
  definitions: BaseRunDefinitions;
}

type LocalChange = BaseRunDefinitions['local_files'][number]['change'];

/** Reads only: no index refresh is written into the operator's checkout. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: FETCH_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter(entry => entry.length > 0);
}

const short = (commit: string): string => commit.slice(0, 12);

/**
 * Compose the base and local layers, hand the composed root to `use`, then remove it.
 *
 * Refuses, with a {@link DefinitionSourceError} that names the files or the ref, when the
 * base cannot be fetched or read, when the checkout has no commit or shares no history
 * with the base, and when a file uncommitted in the checkout also changed on the base
 * since the checkout's merge base with it. There is no fallback to the checkout as it is.
 */
export async function withLayeredDefinitions<T>(
  input: LayeredDefinitionsInput,
  use: (composed: ComposedDefinitions) => Promise<T>
): Promise<T> {
  const top = (await git(input.checkout, ['rev-parse', '--show-toplevel'])).trim();
  const prefix = (await git(input.checkout, ['rev-parse', '--show-prefix'])).trim();
  const { remote, branch, commit } = await fetchBase(input);
  const head = await readHead(top, input.checkout);
  const mergeBase = await readMergeBase(top, input.checkout, head, commit, `${remote}/${branch}`);
  const localConfig = await loadRepoConfig(input.checkout);

  const temp = getArchonTempPath();
  await mkdir(temp, { recursive: true });
  const tempRoot = await mkdtemp(join(temp, 'definitions-'));
  try {
    const tree = join(tempRoot, 'tree');
    await mkdir(tree);
    // The base's own `commands.folder` can widen the paths, so the config comes first.
    const configPath = `${prefix}${PROJECT_CONFIG}`;
    await writeBaseTree(top, commit, tree, [configPath]);
    const root = join(tree, prefix);
    const baseConfig = await loadRepoConfig(root);
    const paths = definitionPaths(prefix, [
      localConfig.commands?.folder,
      baseConfig.commands?.folder,
    ]);
    await writeBaseTree(
      top,
      commit,
      tree,
      paths.filter(path => path !== configPath)
    );

    const ref = `${remote}/${branch}`;
    const local = await localLayer(await localRoots(top, paths, { mergeBase, commit }));
    await refuseConflicts(input.checkout, local, { mergeBase, commit, ref });
    await overlay(tree, local);

    return await use({
      root,
      definitions: {
        from: 'base',
        remote,
        branch,
        commit,
        merge_base: mergeBase,
        checkout: input.checkout,
        local_files: local.map(entry => ({
          path: entry.path.slice(prefix.length),
          change: entry.change,
        })),
      },
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function fetchBase(
  input: LayeredDefinitionsInput
): Promise<{ remote: string; branch: string; commit: string }> {
  const repoPath = input.repoPath ?? input.checkout;
  const worktreeConfig = (await loadRepoConfig(repoPath)).worktree;
  const repo = toRepoPath(input.checkout);
  let remote: string;
  let branch: string | undefined;
  try {
    ({ remote, branch } = await resolveWorktreeBase(toRepoPath(repoPath), worktreeConfig, {
      baseOverride: input.baseOverride,
      baseBranch: input.defaultBranch,
    }));
    branch ??= await getDefaultBranch(repo, remote);
  } catch (error) {
    throw new DefinitionSourceError(
      `Cannot read the base branch for this run's definitions: ${(error as Error).message}`,
      { cause: error }
    );
  }
  const ref = `${remote}/${branch}`;
  try {
    await fetchWithRetry(repo, [remote, `+refs/heads/${branch}:refs/remotes/${ref}`], {
      timeout: FETCH_TIMEOUT_MS,
    });
    const commit = (
      await git(input.checkout, ['rev-parse', '--verify', `refs/remotes/${ref}^{commit}`])
    ).trim();
    return { remote, branch, commit };
  } catch (error) {
    throw new DefinitionSourceError(
      `Cannot read ${ref}, the base branch this run's definitions come from: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

async function readHead(top: string, checkout: string): Promise<string> {
  try {
    return (await git(top, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  } catch (error) {
    throw new DefinitionSourceError(
      `The checkout at ${checkout} has no commit, so its uncommitted changes cannot be laid on the base branch.`,
      { cause: error }
    );
  }
}

async function readMergeBase(
  top: string,
  checkout: string,
  head: string,
  commit: string,
  ref: string
): Promise<string> {
  try {
    return (await git(top, ['merge-base', head, commit])).trim();
  } catch (error) {
    throw new DefinitionSourceError(
      `The checkout at ${checkout} (${short(head)}) shares no history with ${ref} (${short(commit)}), ` +
        "so its uncommitted changes cannot be laid on the base branch. Name it as the run's " +
        'source with --workflow-source or launch.discoveryCwd to run it as it is.',
      { cause: error }
    );
  }
}

/** Repository-relative definition paths, for every command folder either side configures. */
function definitionPaths(prefix: string, commandFolders: (string | undefined)[]): string[] {
  const dirs = new Set(commandFolders.flatMap(folder => projectSourceDirs(folder)));
  return [...dirs, PROJECT_CONFIG].map(path => `${prefix}${path.split(sep).join('/')}`);
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

async function lsTree(
  top: string,
  commit: string,
  paths: readonly string[],
  recursive: boolean
): Promise<TreeEntry[]> {
  if (paths.length === 0) return [];
  const listed = nulList(
    await git(top, ['ls-tree', '-z', ...(recursive ? ['-r'] : []), commit, '--', ...paths])
  );
  return listed.map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
}

/** How many links one base symlink may pass through before it is left as a link. */
const MAX_LINK_HOPS = 8;

/**
 * Write the commit's files under `paths` into `tree`, read from git objects. Unlike
 * `git archive`, this ignores `export-ignore` and other archive attributes: a committed
 * definition is a definition. A committed symlink whose target is in the repository is
 * written as the target's content at the same commit, as the capture follows links; a
 * link out of the repository stays a link to that path in the checkout, as it is today.
 * An initialized submodule is read at its recorded commit.
 */
async function writeBaseTree(
  top: string,
  commit: string,
  tree: string,
  paths: readonly string[]
): Promise<void> {
  const files: { path: string; oid: string; mode: string }[] = [];
  const links: { path: string; target: string }[] = [];
  const gitlinks: { path: string; repo: string; commit: string }[] = [];
  const collect = async (
    entries: TreeEntry[],
    at: (path: string) => string,
    hops: number
  ): Promise<void> => {
    for (const entry of entries) {
      const path = at(entry.path);
      if (entry.mode === '120000') await follow(entry, path, hops);
      else if (entry.mode === '160000')
        gitlinks.push({ path, repo: entry.path, commit: entry.oid });
      else if (entry.type === 'blob') files.push({ path, oid: entry.oid, mode: entry.mode });
    }
  };
  const follow = async (link: TreeEntry, path: string, hops: number): Promise<void> => {
    const target = await linkTarget(top, commit, link, hops);
    if (target.kind === 'link') {
      links.push({ path, target: target.path });
      return;
    }
    const under = (inner: string): string =>
      inner === target.path ? path : `${path}${inner.slice(target.path.length)}`;
    await collect(target.entries, under, hops + 1);
  };
  await collect(await lsTree(top, commit, paths, true), path => path, 0);
  const blobs = await readBlobs(top, [...new Set(files.map(file => file.oid))]);
  for (const file of files) {
    const target = join(tree, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, blobs.get(file.oid) ?? Buffer.alloc(0));
    if (file.mode === '100755') await chmod(target, 0o755);
  }
  for (const link of links) {
    const target = join(tree, link.path);
    await mkdir(dirname(target), { recursive: true });
    await symlink(link.target, target);
  }
  // A submodule is read at the commit the base records for it, from its checkout.
  for (const gitlink of gitlinks) {
    const sub = await submoduleRepo(top, gitlink.repo, [gitlink.commit]);
    if (sub === undefined) continue;
    await mkdir(join(tree, gitlink.path), { recursive: true });
    await writeBaseTree(sub, gitlink.commit, join(tree, gitlink.path), ['.']);
  }
}

/**
 * The checkout of the submodule at `path` in `top`, holding every one of `commits`, or
 * undefined when it is not initialized: an uninitialized submodule is an empty directory,
 * as the capture of the checkout finds it. An initialized one that lacks a commit refuses,
 * naming it, since its definitions at that commit cannot be read.
 */
async function submoduleRepo(
  top: string,
  path: string,
  commits: readonly string[]
): Promise<string | undefined> {
  const sub = join(top, path);
  let subTop: string;
  try {
    subTop = (await git(sub, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return undefined;
  }
  if (resolve(subTop) === resolve(top)) return undefined;
  for (const commit of new Set(commits)) {
    try {
      await git(sub, ['cat-file', '-e', `${commit}^{commit}`]);
    } catch (error) {
      throw new DefinitionSourceError(
        `The submodule at ${path} lacks commit ${short(commit)}, which this run's definitions ` +
          'need. Fetch it in the submodule (git submodule update), then start again.',
        { cause: error }
      );
    }
  }
  return sub;
}

/**
 * What a committed symlink reads at the commit: the entries of its target when that is
 * in the repository, else a link to the path it names in the checkout.
 */
async function linkTarget(
  top: string,
  commit: string,
  link: TreeEntry,
  hops: number
): Promise<
  { kind: 'entries'; path: string; entries: TreeEntry[] } | { kind: 'link'; path: string }
> {
  const text = (await readBlobs(top, [link.oid])).get(link.oid)?.toString('utf8') ?? '';
  const target = posix.normalize(posix.join(posix.dirname(link.path), text));
  const inRepo = !posix.isAbsolute(text) && target !== '..' && !target.startsWith('../');
  if (!inRepo) return { kind: 'link', path: resolve(top, dirname(link.path), text) };
  const found =
    hops < MAX_LINK_HOPS
      ? (await lsTree(top, commit, [target], false)).find(entry => entry.path === target)
      : undefined;
  if (!found) return { kind: 'link', path: join(top, target) };
  return {
    kind: 'entries',
    path: target,
    entries: found.type === 'tree' ? await lsTree(top, commit, [target], true) : [found],
  };
}

/** The bytes of each blob, through one `git cat-file --batch`. */
function readBlobs(top: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  if (oids.length === 0) return Promise.resolve(new Map());
  return new Promise((done, fail) => {
    const child = spawn('git', ['-C', top, 'cat-file', '--batch'], {
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

async function changedBetween(
  repo: string,
  from: string,
  to: string,
  paths: readonly string[]
): Promise<string[]> {
  if (paths.length === 0 || from === to) return [];
  return nulList(
    await git(repo, ['diff', '--name-only', '--no-renames', '-z', from, to, '--', ...paths])
  );
}

/**
 * A place the local layer is read from, compared against its own commits: the repository
 * itself, the target of a definition symlink inside it, or an initialized submodule.
 */
interface LocalRoot {
  repo: string;
  /** Pathspecs in `repo`. */
  paths: string[];
  /** Where a path of `repo` lands in the composed tree, relative to the top. */
  out: (path: string) => string;
  head: string;
  mergeBase: string;
  base: string;
}

interface LocalEntry {
  /** Where the file lands in the composed tree, relative to the top. */
  path: string;
  change: LocalChange;
  root: LocalRoot;
  /** The path in `root.repo`. */
  source: string;
}

/**
 * The roots the local layer is read from. A committed symlink under the definition paths
 * whose target is in the repository adds its target, so an edit made through the link is
 * laid on top and listed under the link's path; a link the checkout itself changed is
 * already an entry of the repository. An initialized submodule adds its own checkout,
 * compared against the commits the superproject records for it.
 */
async function localRoots(
  top: string,
  paths: readonly string[],
  at: { mergeBase: string; commit: string }
): Promise<LocalRoot[]> {
  const main: LocalRoot = {
    repo: top,
    paths: [...paths],
    out: path => path,
    head: 'HEAD',
    mergeBase: at.mergeBase,
    base: at.commit,
  };
  const roots = [main];
  const changedLinks = new Set(
    nulList(await git(top, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--', ...paths]))
  );
  for (const entry of await lsTree(top, 'HEAD', paths, true)) {
    if (entry.mode === '120000' && !changedLinks.has(entry.path)) {
      const target = await linkTarget(top, 'HEAD', entry, 0);
      if (target.kind === 'link') continue;
      roots.push({
        ...main,
        paths: [target.path],
        out: path =>
          path === target.path ? entry.path : `${entry.path}${path.slice(target.path.length)}`,
      });
    } else if (entry.mode === '160000') {
      const recorded = async (commit: string) =>
        (await lsTree(top, commit, [entry.path], false)).find(found => found.mode === '160000')
          ?.oid ?? entry.oid;
      const mergeBase = await recorded(at.mergeBase);
      const base = await recorded(at.commit);
      const sub = await submoduleRepo(top, entry.path, [entry.oid, mergeBase, base]);
      if (sub === undefined) continue;
      roots.push({
        repo: sub,
        paths: ['.'],
        out: path => `${entry.path}/${path}`,
        head: entry.oid,
        mergeBase,
        base,
      });
    }
  }
  return roots;
}

/** Tracked changes against the root's HEAD, then untracked and ignored files, file by file. */
async function localLayer(roots: readonly LocalRoot[]): Promise<LocalEntry[]> {
  const entries: LocalEntry[] = [];
  const submodules = roots.filter(root => root.repo !== roots[0].repo).map(root => root.out(''));
  for (const root of roots) {
    const add = (source: string, change: LocalChange): void => {
      const path = root.out(source);
      // The superproject reports a submodule as one changed path; its own root lists it.
      if (root === roots[0] && submodules.some(sub => `${path}/` === sub || path.startsWith(sub)))
        return;
      entries.push({ path, change, root, source });
    };
    const tracked = nulList(
      await git(root.repo, [
        'diff',
        '--name-status',
        '--no-renames',
        '-z',
        root.head,
        '--',
        ...root.paths,
      ])
    );
    for (let index = 0; index + 1 < tracked.length; index += 2) {
      const status = tracked[index];
      add(tracked[index + 1], status === 'D' ? 'deleted' : status === 'A' ? 'added' : 'modified');
    }
    // One entry per file, so a conflict and the run's record name files, not directories.
    const others = ['ls-files', '-z', '--others', '--exclude-standard'];
    for (const path of nulList(await git(root.repo, [...others, '--', ...root.paths])))
      add(path, 'added');
    for (const path of nulList(await git(root.repo, [...others, '--ignored', '--', ...root.paths])))
      add(path, 'ignored');
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A local file the base also changed since the merge base is the operator's to settle. */
async function refuseConflicts(
  checkout: string,
  local: readonly LocalEntry[],
  at: { mergeBase: string; commit: string; ref: string }
): Promise<void> {
  if (local.length === 0) return;
  const onBase = new Map<LocalRoot, string[]>();
  const conflicts: LocalEntry[] = [];
  for (const entry of local) {
    const { root } = entry;
    if (!onBase.has(root))
      onBase.set(root, await changedBetween(root.repo, root.mergeBase, root.base, root.paths));
    if (onBase.get(root)?.includes(entry.source) && !(await sameAsBase(entry)))
      conflicts.push(entry);
  }
  if (conflicts.length === 0) return;
  const lines = conflicts.map(
    entry =>
      `  ${entry.path}: uncommitted in ${checkout}, and changed on ${at.ref} between ` +
      `${short(at.mergeBase)} and ${short(at.commit)}`
  );
  throw new DefinitionSourceError(
    `Cannot start: definition files changed both in the checkout and on the base branch:\n${lines.join('\n')}\n` +
      `Bring the checkout up to date with ${at.ref} and reapply the change, or discard it, then ` +
      'start again. Committing it does not help: only uncommitted files are laid on the base ' +
      "branch. To run the checkout as it is, name it as the run's source with " +
      '--workflow-source or launch.discoveryCwd.'
  );
}

/** Both sides made the same change: the local file is byte-identical to the base's, or both deleted it. */
async function sameAsBase(entry: LocalEntry): Promise<boolean> {
  const { repo, base } = entry.root;
  const onBase = (await git(repo, ['ls-tree', base, '--', entry.source])).split(/\s+/)[2];
  if (entry.change === 'deleted') return onBase === undefined;
  if (onBase === undefined) return false;
  return (await git(repo, ['hash-object', '--', entry.source])).trim() === onBase;
}

async function overlay(tree: string, local: readonly LocalEntry[]): Promise<void> {
  for (const entry of local) {
    const target = join(tree, entry.path);
    if (entry.change === 'deleted') {
      await rm(target, { force: true });
      continue;
    }
    // Links are followed, as the capture follows them.
    await mkdir(dirname(target), { recursive: true });
    await cp(join(entry.root.repo, entry.source), target, {
      recursive: true,
      dereference: true,
      force: true,
    });
  }
}

/** What a binding's definitions need to know about the registered project it launches in. */
export type DefinitionsProject = Pick<Codebase, 'kind' | 'name' | 'default_cwd' | 'default_branch'>;

type BindingLaunch = Pick<ResourceStartBindingIntent['launch'], 'discoveryCwd' | 'isolation'>;

/** Where a binding start reads its definitions: a directory as it is, or base plus local. */
export type BindingDefinitionsPlan =
  | { kind: 'directory'; root: string; definitions: RunDefinitions }
  | { kind: 'base'; input: LayeredDefinitionsInput };

/**
 * The one rule a binding start and the checks of its binding share. An explicit
 * `discoveryCwd` is read as it is. A folder project or an in-place binding reads its
 * checkout. Anything else reads the base branch with the checkout's uncommitted changes
 * on top: the item's landing branch when it records one, else the binding's base, else
 * the registered project's default branch.
 */
export function bindingDefinitionsPlan(
  launch: BindingLaunch,
  cwd: string,
  project: DefinitionsProject | null,
  landing: string | undefined
): BindingDefinitionsPlan {
  if (launch.discoveryCwd !== undefined) {
    const root = resolve(launch.discoveryCwd);
    return { kind: 'directory', root, definitions: { from: 'source', root } };
  }
  if (project?.kind === 'folder' || launch.isolation.kind === 'in-place')
    return { kind: 'directory', root: cwd, definitions: { from: 'checkout', checkout: cwd } };
  return {
    kind: 'base',
    input: {
      checkout: cwd,
      repoPath: project?.default_cwd ?? cwd,
      baseOverride:
        landing ??
        (launch.isolation.kind === 'worktree' ? launch.isolation.baseOverride : undefined),
      defaultBranch: project?.default_branch?.trim() || undefined,
    },
  };
}

export interface BindingDefinitionsDeps extends Pick<WorkflowDeps, 'loadConfig' | 'providers'> {
  /** The registered project at a launch path, or null when none is registered there. */
  projectOf: (cwd: string) => Promise<DefinitionsProject | null>;
}

/**
 * The workflows a binding's start would run, discovered from the definitions it would
 * capture by {@link bindingDefinitionsPlan}. A standalone check has no item, so it reads
 * the binding's base or the project's default branch; a run that may fire the binding
 * passes its item's landing branch. A checkout outside git with no registered project
 * is read as it is. When the definitions cannot be composed, the reason comes back as the
 * problem and nothing falls back to the checkout.
 */
export async function discoverBindingWorkflows(
  launch: BindingLaunch & Pick<ResourceStartBindingIntent['launch'], 'cwd'>,
  deps: BindingDefinitionsDeps,
  landing?: (project: DefinitionsProject) => Promise<string | undefined>
): Promise<{ discovered: WorkflowLoadResult } | { refused: string }> {
  const discover = (root: string): Promise<WorkflowLoadResult> =>
    discoverWorkflowsWithConfig(root, deps.loadConfig, deps.providers);
  const project = await deps.projectOf(launch.cwd);
  if (!project && !(await insideGit(launch.cwd)))
    return { discovered: await discover(launch.discoveryCwd ?? launch.cwd) };
  const plan = bindingDefinitionsPlan(
    launch,
    launch.cwd,
    project,
    project && landing ? await landing(project) : undefined
  );
  if (plan.kind === 'directory') return { discovered: await discover(plan.root) };
  try {
    return {
      discovered: await withLayeredDefinitions(plan.input, composed => discover(composed.root)),
    };
  } catch (error) {
    if (error instanceof DefinitionSourceError) return { refused: error.message };
    throw error;
  }
}

async function insideGit(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    // Not a repository: a folder project, which runs in place on what is there.
    return false;
  }
}
