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
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  execFileAsync,
  fetchWithRetry,
  getDefaultBranch,
  toBranchName,
  toRepoPath,
} from '@archon/git';
import { resolveWorktreeBase } from '@archon/isolation';
import { getArchonTempPath } from '@archon/paths';
import type { WorkflowDeps } from '@archon/workflows/deps';
import type { BaseRunDefinitions, RunDefinitions } from '@archon/workflows/schemas/run-metadata';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import {
  capturedSourceRoots,
  changedPaths,
  commitView,
  resolveRunSourceCapture,
  type WorkflowSourceRoots,
  DefinitionViewError,
  projectSourceDirs,
  sameEntry,
  worktreeView,
  writeEntry,
  writeView,
  type DefinitionView,
} from '@archon/workflows/workflow-source';
import { readWorkflowSourceState, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { readFile } from 'node:fs/promises';
import { loadRepoConfig } from '../config/config-loader';
import { isConfigRecord } from '../config/config-validation';
import { selectStartedWorkflow } from './binding-workflow';
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
  /**
   * The environment the base fetch authenticates with; this process's env when unset.
   * A binding start sets it to its run-as user's GitHub environment, so the fetch never
   * borrows the caller's credential, nor its scrub.
   */
  fetchEnv?: NodeJS.ProcessEnv;
}

export interface ComposedDefinitions {
  /** A project root holding the composed definitions; removed when `use` returns. */
  root: string;
  definitions: BaseRunDefinitions;
}

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
  const ref = baseRefName({ remote, branch });
  const mergeBase = await readMergeBase(top, input.checkout, head, commit, ref);
  // The folders only widen what is read. Validating either config here would refuse a
  // committed fault the uncommitted layer repairs; the composed config is validated below.
  const localFolder = await readCommandFolder(input.checkout);

  const temp = getArchonTempPath();
  await mkdir(temp, { recursive: true });
  const tempRoot = await mkdtemp(join(temp, 'definitions-'));
  try {
    const tree = join(tempRoot, 'tree');
    await mkdir(tree);
    // The base's own `commands.folder` can widen the paths, so the config comes first.
    await writeView(
      await readView(() => commitView(top, commit, [`${prefix}${PROJECT_CONFIG}`])),
      tree
    );
    const root = join(tree, prefix);
    const paths = definitionPaths(prefix, [localFolder, await readCommandFolder(root)]);
    // One enumeration for every layer: each view resolves links and submodules alike.
    const base = await readView(() => commitView(top, commit, paths));
    const worktree = await readView(() => worktreeView(top, paths));
    const committed = await readView(() => commitView(top, head, paths));
    const local = changedPaths(committed, worktree);
    if (local.length > 0) {
      const mergeBaseView = await readView(() => commitView(top, mergeBase, paths));
      refuseConflicts(
        input.checkout,
        local,
        { base, mergeBase: mergeBaseView, worktree },
        { mergeBase, commit, ref },
        prefix
      );
    }
    await writeView(base, tree);
    for (const { path } of local) await writeEntry(tree, path, worktree.get(path));
    const ignored = local.length > 0 ? await ignoredFiles(top, paths) : new Set<string>();
    await refuseInvalidConfig(root, local, `${prefix}${PROJECT_CONFIG}`, ref);

    return await use({
      root,
      definitions: {
        from: 'base',
        ...(remote !== undefined ? { remote } : {}),
        branch,
        commit,
        merge_base: mergeBase,
        checkout: input.checkout,
        local_files: local.map(({ path, change }) => ({
          path: path.slice(prefix.length),
          change: change === 'added' && ignored.has(path) ? 'ignored' : change,
        })),
      },
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * The remote and branch a run's base is: the override, else the registered checkout's
 * `worktree.baseBranch`, else the project's default branch, else the remote's HEAD. The
 * precedence worktree creation uses, so the base definitions are read from and the base a
 * worktree is cut from are one branch. A repository with no remote has a local base, as
 * creation has: the configured branch, else the registered checkout's current branch.
 */
export async function resolveDefinitionsBase(
  input: LayeredDefinitionsInput
): Promise<{ remote: string | undefined; branch: string }> {
  const repoPath = input.repoPath ?? input.checkout;
  try {
    const worktreeConfig = (await loadRepoConfig(repoPath)).worktree ?? null;
    const base = await resolveWorktreeBase(toRepoPath(repoPath), worktreeConfig, {
      baseOverride: input.baseOverride ? toBranchName(input.baseOverride) : undefined,
      baseBranch: input.defaultBranch ? toBranchName(input.defaultBranch) : undefined,
    });
    if (base.remote === undefined) return base;
    return {
      remote: base.remote,
      branch: base.branch ?? (await getDefaultBranch(toRepoPath(input.checkout), base.remote)),
    };
  } catch (error) {
    throw new DefinitionSourceError(
      `Cannot read the base branch for this run's definitions: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

/** How a base is named in messages: `<remote>/<branch>`, or the local branch alone. */
export function baseRefName(base: { remote?: string; branch: string }): string {
  return base.remote === undefined ? base.branch : `${base.remote}/${base.branch}`;
}

/**
 * The `commands.folder` a project config names, read without validating anything else:
 * it only widens which files are read, and the composed config is validated on its own.
 * A missing or unparsable file names no folder.
 */
async function readCommandFolder(root: string): Promise<string | undefined> {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(await readFile(join(root, PROJECT_CONFIG), 'utf8'));
  } catch {
    return undefined;
  }
  const commands = isConfigRecord(raw) ? raw.commands : undefined;
  const folder = isConfigRecord(commands) ? commands.folder : undefined;
  return typeof folder === 'string' ? folder : undefined;
}

/** The composed config is the one the run uses, so it is the one that must be valid. */
async function refuseInvalidConfig(
  root: string,
  local: readonly { path: string }[],
  configPath: string,
  ref: string
): Promise<void> {
  try {
    await loadRepoConfig(root);
  } catch (error) {
    const side = local.some(file => file.path === configPath)
      ? 'the uncommitted copy in the checkout'
      : `the copy on ${ref}`;
    throw new DefinitionSourceError(
      `This run's ${PROJECT_CONFIG}, ${side}, is invalid: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

/**
 * The base commit, fetched now from its remote. With no remote there is nothing to fetch:
 * the local branch is the base, as it is for the worktree cut from it.
 */
async function fetchBase(
  input: LayeredDefinitionsInput
): Promise<{ remote: string | undefined; branch: string; commit: string }> {
  const repo = toRepoPath(input.checkout);
  const { remote, branch } = await resolveDefinitionsBase(input);
  const ref = baseRefName({ remote, branch });
  try {
    if (remote !== undefined)
      await fetchWithRetry(repo, [remote, `+refs/heads/${branch}:refs/remotes/${ref}`], {
        timeout: FETCH_TIMEOUT_MS,
        env: input.fetchEnv,
      });
    const local = remote === undefined ? `refs/heads/${ref}` : `refs/remotes/${ref}`;
    const commit = (
      await git(input.checkout, ['rev-parse', '--verify', `${local}^{commit}`])
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

/** The paths git reports ignored under `paths`, relative to `top`. */
async function ignoredFiles(top: string, paths: readonly string[]): Promise<Set<string>> {
  return new Set(
    nulList(
      await git(top, [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        ...paths,
      ])
    )
  );
}

/**
 * A local file the base also changed since the merge base is the operator's to settle,
 * unless both made the same change. Compared on resolved views, so a base that retargets
 * a symlink conflicts with a local edit to its old target.
 */
function refuseConflicts(
  checkout: string,
  local: readonly { path: string }[],
  views: { base: DefinitionView; mergeBase: DefinitionView; worktree: DefinitionView },
  at: { mergeBase: string; commit: string; ref: string },
  prefix: string
): void {
  const conflicts = local.filter(
    ({ path }) =>
      !sameEntry(views.base.get(path), views.mergeBase.get(path)) &&
      !sameEntry(views.worktree.get(path), views.base.get(path))
  );
  if (conflicts.length === 0) return;
  const lines = conflicts.map(
    ({ path }) =>
      `  ${path.slice(prefix.length)}: uncommitted in ${checkout}, and changed on ${at.ref} between ` +
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

/** Read a view, translating a submodule that lacks a commit into a refused start. */
async function readView<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof DefinitionViewError)
      throw new DefinitionSourceError(error.message, { cause: error });
    throw error;
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
 * The workflows a binding's start would run, discovered by {@link bindingDefinitionsPlan}.
 *
 * - A check made as a run starts (`launchRun`, the run whose end or asks may fire the
 *   binding) reads that run's own captured definitions when they came from the base
 *   branch: the definitions that launch executes, with no second fetch.
 * - A standalone check composes afresh: the binding's base, else the registered project's
 *   default branch, as fetched now, with the checkout's uncommitted changes on top.
 *
 * A checkout outside git with no registered project is read as it is. When the base
 * cannot be composed and the workflow the binding starts pins itself in place, the
 * checkout is read as it is, as its start reads it. Any other composition failure comes
 * back as the problem; nothing falls back to the checkout.
 */
export async function discoverBindingWorkflows(
  launch: BindingLaunch & Pick<ResourceStartBindingIntent['launch'], 'cwd' | 'workflowName'>,
  deps: BindingDefinitionsDeps,
  launchRun?: Pick<WorkflowRun, 'metadata'>
): Promise<{ discovered: WorkflowLoadResult } | { refused: string }> {
  const discover = (root: string, roots?: WorkflowSourceRoots): Promise<WorkflowLoadResult> =>
    discoverWorkflowsWithConfig(root, deps.loadConfig, deps.providers, roots);
  const project = await deps.projectOf(launch.cwd);
  if (!project && !(await insideGit(launch.cwd)))
    return { discovered: await discover(launch.discoveryCwd ?? launch.cwd) };
  const plan = bindingDefinitionsPlan(launch, launch.cwd, project, undefined);
  if (plan.kind === 'directory') return { discovered: await discover(plan.root) };
  const capture = launchRun ? await launchCapture(launchRun) : undefined;
  if (capture) return { discovered: await discover(launch.cwd, capture) };
  try {
    return {
      discovered: await withLayeredDefinitions(plan.input, composed => discover(composed.root)),
    };
  } catch (error) {
    if (!(error instanceof DefinitionSourceError)) throw error;
    const live = await discover(launch.cwd);
    if (startsPinnedInPlace(launch, live)) return { discovered: live };
    return { refused: error.message };
  }
}

/**
 * Whether the workflow a binding starts, as `discovered` holds it, pins itself in place.
 * Read only when the base cannot be composed: an in-place workflow reads its checkout as
 * it is, so neither its start nor its check needs the base.
 */
export function startsPinnedInPlace(
  launch: Pick<ResourceStartBindingIntent['launch'], 'workflowName'>,
  discovered: WorkflowLoadResult
): boolean {
  const started = selectStartedWorkflow(launch, discovered);
  return 'workflow' in started && started.workflow.worktree?.enabled === false;
}

/** The capture of a launching run whose definitions came from the base branch. */
async function launchCapture(
  run: Pick<WorkflowRun, 'metadata'>
): Promise<WorkflowSourceRoots | undefined> {
  const state = readWorkflowSourceState(run.metadata);
  if (state.kind !== 'recorded' || state.record.definitions?.from !== 'base') return undefined;
  const capture = await resolveRunSourceCapture(run.metadata);
  return capture ? capturedSourceRoots(capture.anchor) : undefined;
}

async function insideGit(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    // Not a repository: a folder project, which runs in place on what is there.
    return false;
  }
}
