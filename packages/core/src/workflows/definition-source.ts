/**
 * A run's definitions: the project's workflows, commands, scripts, in-repository packs
 * and `.archon/config.yaml` as they are on the base branch fetched now, with the files
 * uncommitted in the operator's checkout laid on top.
 *
 * The two layers are composed into a temporary directory that only feeds the run's
 * capture; nothing is written into the run's checkout or the operator's. The operator's
 * checkout is only read: the fetch moves the remote-tracking ref and nothing else.
 */
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { execFileAsync, fetchWithRetry, getDefaultBranch, toRepoPath } from '@archon/git';
import { resolveWorktreeBase } from '@archon/isolation';
import { getArchonTempPath } from '@archon/paths';
import type { WorkflowDeps } from '@archon/workflows/deps';
import type { BaseRunDefinitions } from '@archon/workflows/schemas/run-metadata';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { projectSourceDirs } from '@archon/workflows/workflow-source';
import { loadRepoConfig } from '../config/config-loader';

/**
 * Write `commit`'s tree, or only `paths` of it, into the empty directory `dest`. Every
 * path must exist in the commit: `git archive` refuses one that does not.
 */
export async function extractCommitTree(
  repo: string,
  commit: string,
  dest: string,
  paths: readonly string[] = []
): Promise<void> {
  const archive = `${dest}.tar`;
  try {
    await execFileAsync(
      'git',
      [
        'archive',
        '--format=tar',
        `--output=${archive}`,
        commit,
        ...(paths.length ? ['--', ...paths] : []),
      ],
      { cwd: repo }
    );
    await execFileAsync('tar', ['-xf', archive, '-C', dest]);
  } finally {
    await rm(archive, { force: true });
  }
}

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
 * with the base, when the checkout's commits change definitions the base does not have,
 * and when a file uncommitted in the checkout also changed on the base since the
 * checkout's merge base. There is no fallback to the checkout as it is.
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
    await extractExisting(top, commit, tree, [`${prefix}${PROJECT_CONFIG}`]);
    const root = join(tree, prefix);
    const baseConfig = await loadRepoConfig(root);
    const paths = definitionPaths(prefix, [
      localConfig.commands?.folder,
      baseConfig.commands?.folder,
    ]);
    await extractExisting(
      top,
      commit,
      tree,
      paths.filter(path => path !== `${prefix}${PROJECT_CONFIG}`)
    );

    const ref = `${remote}/${branch}`;
    await refuseUnlandedCommits(top, input.checkout, { head, mergeBase, commit, ref }, paths);
    const local = await localLayer(top, paths);
    await refuseConflicts(top, input.checkout, local, { mergeBase, commit, ref }, paths);
    await overlay(top, tree, local);

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

/** Extract those of `paths` the commit has: `git archive` refuses a missing one. */
async function extractExisting(
  top: string,
  commit: string,
  tree: string,
  paths: readonly string[]
): Promise<void> {
  if (paths.length === 0) return;
  const existing = nulList(
    await git(top, ['ls-tree', '-z', '--name-only', commit, '--', ...paths])
  );
  if (existing.length > 0) await extractCommitTree(top, commit, tree, existing);
}

async function changedBetween(
  top: string,
  from: string,
  to: string,
  paths: readonly string[]
): Promise<string[]> {
  if (paths.length === 0) return [];
  return nulList(
    await git(top, ['diff', '--name-only', '--no-renames', '-z', from, to, '--', ...paths])
  );
}

/**
 * Commits on the checkout's branch that change definitions the base does not have. They
 * would be dropped without a word, since only uncommitted changes are laid on the base.
 * Compared by content, so a change the base already took (a squash merge) is not counted.
 */
async function refuseUnlandedCommits(
  top: string,
  checkout: string,
  at: { head: string; mergeBase: string; commit: string; ref: string },
  paths: readonly string[]
): Promise<void> {
  const committed = await changedBetween(top, at.mergeBase, at.head, paths);
  const unlanded = await changedBetween(top, at.commit, at.head, committed);
  if (unlanded.length === 0) return;
  throw new DefinitionSourceError(
    `The checkout at ${checkout} has commits that change definitions ${at.ref} does not have: ` +
      `${unlanded.join(', ')}. A run reads its definitions from ${at.ref} with only uncommitted ` +
      'changes on top, so these would be dropped. Land them on the base branch, or name the ' +
      "checkout as the run's source with --workflow-source or launch.discoveryCwd."
  );
}

interface LocalEntry {
  /** Repository-relative; a directory ends with `/` and is taken whole. */
  path: string;
  change: LocalChange;
}

/** Tracked changes against HEAD, then untracked and ignored files, under the definition paths. */
async function localLayer(top: string, paths: readonly string[]): Promise<LocalEntry[]> {
  const entries: LocalEntry[] = [];
  const tracked = nulList(
    await git(top, ['diff', '--name-status', '--no-renames', '-z', 'HEAD', '--', ...paths])
  );
  for (let index = 0; index + 1 < tracked.length; index += 2) {
    const status = tracked[index];
    const change: LocalChange = status === 'D' ? 'deleted' : status === 'A' ? 'added' : 'modified';
    entries.push({ path: tracked[index + 1], change });
  }
  const others = [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
    '--directory',
    '--no-empty-directory',
  ];
  for (const path of nulList(await git(top, [...others, '--', ...paths])))
    entries.push({ path, change: 'added' });
  for (const path of nulList(await git(top, [...others, '--ignored', '--', ...paths])))
    entries.push({ path, change: 'ignored' });
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A local file the base also changed since the merge base is the operator's to settle. */
async function refuseConflicts(
  top: string,
  checkout: string,
  local: readonly LocalEntry[],
  at: { mergeBase: string; commit: string; ref: string },
  paths: readonly string[]
): Promise<void> {
  if (local.length === 0) return;
  const onBase = await changedBetween(top, at.mergeBase, at.commit, paths);
  const conflicts: LocalEntry[] = [];
  for (const entry of local) {
    const touched = entry.path.endsWith('/')
      ? onBase.some(path => path.startsWith(entry.path))
      : onBase.includes(entry.path);
    if (touched && !(await sameAsBase(top, at.commit, entry))) conflicts.push(entry);
  }
  if (conflicts.length === 0) return;
  const lines = conflicts.map(
    entry =>
      `  ${entry.path}: uncommitted in ${checkout}, and changed on ${at.ref} between ` +
      `${short(at.mergeBase)} and ${short(at.commit)}`
  );
  throw new DefinitionSourceError(
    `Cannot start: definition files changed both in the checkout and on the base branch:\n${lines.join('\n')}\n` +
      'Commit, discard or update the local change, then start again.'
  );
}

/** Both sides made the same change: the local file is byte-identical to the base's, or both deleted it. */
async function sameAsBase(top: string, commit: string, entry: LocalEntry): Promise<boolean> {
  if (entry.path.endsWith('/')) return false;
  const onBase = (await git(top, ['ls-tree', commit, '--', entry.path])).split(/\s+/)[2];
  if (entry.change === 'deleted') return onBase === undefined;
  if (onBase === undefined) return false;
  return (await git(top, ['hash-object', '--', entry.path])).trim() === onBase;
}

async function overlay(top: string, tree: string, local: readonly LocalEntry[]): Promise<void> {
  for (const entry of local) {
    const target = join(tree, entry.path);
    if (entry.change === 'deleted') {
      await rm(target, { force: true });
      continue;
    }
    // Links are followed, as the capture follows them.
    await mkdir(dirname(target), { recursive: true });
    await cp(join(top, entry.path), target, { recursive: true, dereference: true, force: true });
  }
}

/**
 * The workflows a binding's start would run: discovered from the definitions it would
 * capture, so a check judges what the start will run. An explicit `discoveryCwd`, an
 * in-place binding, and a checkout outside git are read as they are; anything else is the
 * base branch, fetched now, with the checkout's uncommitted changes on top. When those
 * cannot be composed, the reason comes back as the problem and nothing falls back to the
 * checkout.
 */
export async function discoverBindingWorkflows(
  launch: Pick<ResourceStartBindingIntent['launch'], 'cwd' | 'discoveryCwd' | 'isolation'>,
  deps: Pick<WorkflowDeps, 'loadConfig' | 'providers'>
): Promise<{ discovered: WorkflowLoadResult } | { refused: string }> {
  const discover = (root: string): Promise<WorkflowLoadResult> =>
    discoverWorkflowsWithConfig(root, deps.loadConfig, deps.providers);
  if (launch.discoveryCwd !== undefined) return { discovered: await discover(launch.discoveryCwd) };
  if (launch.isolation.kind === 'in-place' || !(await insideGit(launch.cwd)))
    return { discovered: await discover(launch.cwd) };
  try {
    return {
      discovered: await withLayeredDefinitions(
        {
          checkout: launch.cwd,
          baseOverride:
            launch.isolation.kind === 'worktree' ? launch.isolation.baseOverride : undefined,
        },
        composed => discover(composed.root)
      ),
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
