/**
 * The landing branch a fresh run on an item starts from, checked against the remote the
 * worktree would be cut from. Both start paths (a trigger-file stage, a hand start with
 * `--item`) call this before any node runs, so a missing branch refuses the run instead of
 * cutting it from the base.
 */
import { getDefaultRemote, inspectRemoteBranches, toRepoPath } from '@archon/git';
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
  if (codebase.kind === 'folder')
    throw new LandingBranchRefusedError(
      `${subject}, but project '${codebase.name}' is a folder with no git branches; the run is refused.`
    );
  const repoPath = toRepoPath(codebase.default_cwd);
  const config = await loadRepoConfig(codebase.default_cwd);
  const remote = config.worktree?.remote?.trim() || (await getDefaultRemote(repoPath));
  if (!remote)
    throw new LandingBranchRefusedError(
      `${subject}, but project '${codebase.name}' has no remote to cut it from; set worktree.remote. The run is refused.`
    );
  const advertised = await inspectRemoteBranches({ kind: 'local', repoPath, remote });
  if (advertised.status === 'unavailable')
    throw new LandingBranchRefusedError(
      `${subject}, but remote '${remote}' could not be read: ${advertised.evidence}. The run is refused.`,
      advertised.failure ? { cause: advertised.failure } : undefined
    );
  if (!advertised.branches.some(branch => branch === landing.branch))
    throw new LandingBranchRefusedError(
      `${subject}, but '${landing.branch}' is not on remote '${remote}'. Push the branch, or record another with 'archon workflow landing --item ${landing.from.kind === 'own' ? item.key : landing.from.item.key} --branch <name>'. The run is refused.`
    );
  return landing;
}
