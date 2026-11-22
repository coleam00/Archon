/**
 * The landing branch a fresh run on an item starts from, checked against the remote the
 * worktree would be cut from. Both start paths (a trigger-file stage, a hand start with
 * `--item`) call this before any node runs, so a missing branch refuses the run instead of
 * cutting it from the base. A start never creates the branch: only `createLandingBranch`,
 * behind `archon workflow landing --from`, does, from a start point its caller names.
 */
import {
  execFileAsync,
  fetchWithRetry,
  getDefaultRemote,
  GitFailure,
  inspectRemoteBranches,
  toRepoPath,
  type RepoPath,
} from '@archon/git';
import { landingSourceText, resolveItemLanding } from '@archon/workflows/item-landing';
import type { ResolvedItemLanding } from '@archon/workflows/schemas/item-landing';
import type { WorkflowItem } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import { loadRepoConfig } from '../config/config-loader';
import type { Codebase } from '../schemas/codebase';

/** The item's landing branch cannot be used: not on the remote, unreadable, or the run works in place. */
export class LandingBranchRefusedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LandingBranchRefusedError';
  }
}

function describe(item: WorkflowItem, landing: ResolvedItemLanding): string {
  const source =
    landing.from.kind === 'own' ? 'recorded on it' : `from ${landingSourceText(landing)}`;
  return `Item '${item.key}' lands on '${landing.branch}' (${source})`;
}

/**
 * Refuse a run on `item` that would work in place: it cannot be cut from the landing
 * branch, and reporting the branch as `$BASE_BRANCH` over another checkout is the mismatch
 * the landing branch exists to remove. `--base` is refused there for the same reason.
 */
export function refuseInPlaceLanding(item: WorkflowItem, landing: ResolvedItemLanding): never {
  throw new LandingBranchRefusedError(
    `${describe(item, landing)}, but this run would work in place, not in a worktree cut from it. Run it with worktree isolation; the run is refused.`
  );
}

/** The command that creates `branch` on the remote and records it on `itemKey`. */
export function landingCreateCommand(itemKey: string, branch: string): string {
  return `archon workflow landing --item ${itemKey} --branch ${branch} --from <start-point>`;
}

/**
 * The remote a landing branch lives on: the one a run's worktree is cut from, so creating
 * the branch and starting a run on it can never pick different remotes. `refuse` turns
 * the problem into its caller's error.
 */
async function landingRemote(
  codebase: Pick<Codebase, 'kind' | 'name' | 'default_cwd'>,
  refuse: (problem: string) => Error
): Promise<{ repoPath: RepoPath; remote: string }> {
  if (codebase.kind === 'folder')
    throw refuse(`project '${codebase.name}' is a folder with no git branches`);
  const repoPath = toRepoPath(codebase.default_cwd);
  const config = await loadRepoConfig(codebase.default_cwd);
  const remote = config.worktree?.remote?.trim() || (await getDefaultRemote(repoPath));
  if (!remote)
    throw refuse(`project '${codebase.name}' has no remote to cut it from; set worktree.remote`);
  return { repoPath, remote };
}

/** The branches `remote` advertises; `refuse` turns an unreadable remote into the caller's error. */
async function advertisedBranches(
  repoPath: RepoPath,
  remote: string,
  refuse: (problem: string, options?: ErrorOptions) => Error
): Promise<string[]> {
  const advertised = await inspectRemoteBranches({ kind: 'local', repoPath, remote });
  if (advertised.status === 'unavailable')
    throw refuse(
      `remote '${remote}' could not be read: ${advertised.evidence}`,
      advertised.failure ? { cause: advertised.failure } : undefined
    );
  return advertised.branches;
}

/**
 * Resolve where a run on `item` lands and check that the branch is on the remote. Null
 * when nothing records a branch, so the run takes its base as it would without an item.
 */
export async function resolveRunLanding(
  store: Pick<IWorkflowStore, 'getItemLanding' | 'listItemLinks'>,
  codebase: Pick<Codebase, 'kind' | 'name' | 'default_cwd'>,
  item: WorkflowItem
): Promise<ResolvedItemLanding | null> {
  const landing = await resolveItemLanding(store, item);
  if (landing === null) return null;
  const subject = describe(item, landing);
  const refuse = (problem: string, options?: ErrorOptions) =>
    new LandingBranchRefusedError(`${subject}, but ${problem}. The run is refused.`, options);
  const { repoPath, remote } = await landingRemote(codebase, refuse);
  const branches = await advertisedBranches(repoPath, remote, refuse);
  if (!branches.includes(landing.branch)) {
    const owner = landing.from.kind === 'own' ? item.key : landing.from.item.key;
    throw new LandingBranchRefusedError(
      `${subject}, but '${landing.branch}' is not on remote '${remote}'. Create it with '${landingCreateCommand(owner, landing.branch)}', or record another branch. The run is refused.`
    );
  }
  return landing;
}

export type CreatedLandingBranch =
  | { remote: string; status: 'created'; commit: string }
  | { remote: string; status: 'exists' };

/** Creating a landing branch failed; nothing was recorded. */
export class LandingBranchCreateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LandingBranchCreateError';
  }
}

/**
 * Create `branch` on the project's landing remote at `startPoint`, which resolves in the
 * project's repository after a fetch, as `workflow run --from` does. A branch already on
 * the remote is left where it is and reported as `exists`.
 */
export async function createLandingBranch(
  codebase: Pick<Codebase, 'kind' | 'name' | 'default_cwd'>,
  branch: string,
  startPoint: string
): Promise<CreatedLandingBranch> {
  const subject = `Creating '${branch}' from '${startPoint}'`;
  const refuse = (problem: string, options?: ErrorOptions) =>
    new LandingBranchCreateError(`${subject}, but ${problem}.`, options);
  const { repoPath, remote } = await landingRemote(codebase, refuse);
  const read = async (): Promise<boolean> =>
    (await advertisedBranches(repoPath, remote, refuse)).includes(branch);
  if (await read()) return { remote, status: 'exists' };

  await fetchWithRetry(repoPath, ['--no-tags', remote], { timeout: 60000 });
  let commit: string;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--end-of-options', `${startPoint}^{commit}`],
      { timeout: 10000 }
    );
    commit = stdout.trim();
  } catch (error) {
    // Git ran and could not resolve it; a spawn failure or timeout is not a bad start point.
    if (!(error instanceof GitFailure) || typeof error.code !== 'number' || error.killed)
      throw error;
    throw new LandingBranchCreateError(
      `--from '${startPoint}' does not name a commit in project '${codebase.name}'.`,
      { cause: error }
    );
  }
  // The lease with an empty expected value makes git refuse a ref the remote already has; a
  // plain push would fast-forward an existing branch to a descendant start point.
  const ref = `refs/heads/${branch}`;
  try {
    await execFileAsync(
      'git',
      [
        '-C',
        repoPath,
        'push',
        '--porcelain',
        `--force-with-lease=${ref}:`,
        '--',
        remote,
        `${commit}:${ref}`,
      ],
      { timeout: 60000 }
    );
    return { remote, status: 'created', commit };
  } catch (error) {
    if (!(error instanceof GitFailure) || typeof error.code !== 'number' || error.killed)
      throw error;
    // Git's rejection text is not classified: reading the remote again tells a caller that
    // created the branch first from a push that failed.
    if (await read()) return { remote, status: 'exists' };
    throw new LandingBranchCreateError(
      `${subject}, but the push to remote '${remote}' failed: ${error.message}`,
      { cause: error }
    );
  }
}
