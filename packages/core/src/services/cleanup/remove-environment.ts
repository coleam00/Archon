import {
  getIsolationProvider,
  readWorktreeBranchCreated,
  readWorktreeCreationId,
} from '@archon/isolation';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import {
  hasUncommittedChangesStrict,
  toBranchName,
  toRepoPath,
  toWorktreePath,
  worktreeExists,
} from '@archon/git';
import type { RepoPath } from '@archon/git';
import { unknownPlatformReason, type UnknownPlatformReason } from '../../platforms/registry';
import * as isolationEnvDb from '../../db/isolation-environments';
import * as codebaseDb from '../../db/codebases';
import { getLog } from './log';

export interface RemoveEnvironmentOptions {
  force?: boolean;
  /** Requests finished local-branch cleanup; remote refs are always retained. */
  deleteRemoteBranch?: boolean;
}

const NON_WORKTREE_CLEANUP_REASON =
  'not a worktree environment; archon isolation cleanup 0 only removes eligible containers from registered platforms that do not retain workspaces. Cancel or abandon the owning workflow first if it is live or resumable.';

const INCOMPLETE_REMOVAL_REASON = 'filesystem removal incomplete; environment remains active';

export interface RemoveEnvironmentResult {
  /** Whether the worktree was removed from disk */
  worktreeRemoved: boolean;
  /** Whether the branch was deleted (null if branch cleanup was not attempted) */
  branchDeleted: boolean | null;
  /**
   * Why removal did not proceed. A closed set so callers that branch
   * on a reason fail type-check when it changes, instead of silently diverging.
   */
  skippedReason?:
    | 'already destroyed'
    | typeof NON_WORKTREE_CLEANUP_REASON
    | 'has uncommitted changes'
    | typeof INCOMPLETE_REMOVAL_REASON
    | UnknownPlatformReason;
  /** Warnings from partial cleanup (e.g., branch couldn't be deleted) */
  warnings: string[];
}

export function incompleteRemovalReason(removal: RemoveEnvironmentResult): string | undefined {
  return removal.skippedReason === INCOMPLETE_REMOVAL_REASON ? removal.skippedReason : undefined;
}

type DestroyResult = Awaited<ReturnType<ReturnType<typeof getIsolationProvider>['destroy']>>;

/**
 * Remove a specific environment
 */
export async function removeEnvironment(
  env: IsolationEnvironmentRow,
  options?: RemoveEnvironmentOptions
): Promise<RemoveEnvironmentResult> {
  const refusal = removalRefusal(env);
  if (refusal) return { worktreeRemoved: false, branchDeleted: false, warnings: [], ...refusal };

  const canonicalRepoPath = await readCanonicalRepoPath(env);
  // Check if directory exists before attempting removal
  const pathExists = await worktreeExists(toWorktreePath(env.working_path));

  try {
    if (pathExists && !options?.force && (await hasUncommittedWork(env))) {
      return {
        worktreeRemoved: false,
        branchDeleted: false,
        warnings: [],
        skippedReason: 'has uncommitted changes',
      };
    }
    const destroyResult = await destroyRegisteredWorktree(env, canonicalRepoPath, options);
    return reportRemoval(env, destroyResult, options);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, envId: env.id }, 'env_remove_failed');
    throw err;
  }
}

/** Why the environment is not this function's to remove, before anything touches disk. */
function removalRefusal(
  env: IsolationEnvironmentRow
): Pick<RemoveEnvironmentResult, 'skippedReason'> | null {
  if (env.status === 'destroyed') {
    getLog().debug({ envId: env.id }, 'env_already_destroyed');
    return { skippedReason: 'already destroyed' };
  }
  if (env.provider !== 'worktree') return { skippedReason: NON_WORKTREE_CLEANUP_REASON };
  const reason = unknownPlatformReason(env.created_by_platform);
  return reason ? { skippedReason: reason } : null;
}

/** The codebase's main checkout, which branch cleanup runs against. */
async function readCanonicalRepoPath(env: IsolationEnvironmentRow): Promise<RepoPath | undefined> {
  if (!env.codebase_id) return undefined;
  const codebase = await codebaseDb.getCodebase(env.codebase_id);
  return codebase?.default_cwd ? toRepoPath(codebase.default_cwd) : undefined;
}

async function hasUncommittedWork(env: IsolationEnvironmentRow): Promise<boolean> {
  const hasChanges = await hasUncommittedChangesStrict(toWorktreePath(env.working_path));
  if (hasChanges) {
    getLog().warn({ envId: env.id, workingPath: env.working_path }, 'env_has_uncommitted_changes');
  }
  return hasChanges;
}

function destroyRegisteredWorktree(
  env: IsolationEnvironmentRow,
  canonicalRepoPath: RepoPath | undefined,
  options: RemoveEnvironmentOptions | undefined
): Promise<DestroyResult> {
  return isolationEnvDb.withWorktreeRegistration(env, async markDestroyed => {
    const provider = getIsolationProvider();
    // A branch this environment did not create (an existing branch it checked out)
    // may hold the only copy of someone's commits, so local deletion requires a
    // request for remote cleanup. Callers request that only when the branch is finished:
    // merged, or an operator's explicit `--include-closed` or `archon complete`.
    const deleteBranch = readWorktreeBranchCreated(env.metadata) || options?.deleteRemoteBranch;
    const destroyResult = await provider.destroy(env.working_path, {
      force: options?.force,
      creationId: readWorktreeCreationId(env.metadata) ?? undefined,
      ...(deleteBranch ? { branchName: toBranchName(env.branch_name) } : {}),
      canonicalRepoPath,
    });

    if (destroyResult.worktreeRemoved && destroyResult.directoryClean) await markDestroyed();
    return destroyResult;
  });
}

function reportRemoval(
  env: IsolationEnvironmentRow,
  destroyResult: DestroyResult,
  options: RemoveEnvironmentOptions | undefined
): RemoveEnvironmentResult {
  const removed = destroyResult.worktreeRemoved && destroyResult.directoryClean;
  // A remote OID cannot prove registration ownership after the claim commits:
  // a replacement may publish the same commit before a delayed push executes.
  if (removed && options?.deleteRemoteBranch) {
    destroyResult.warnings.push(
      `Remote branch retained '${env.branch_name}': registration ownership cannot be verified after local cleanup; inspect the push destination before deleting it manually`
    );
  }
  if (destroyResult.warnings.length > 0) {
    getLog().warn({ envId: env.id, warnings: destroyResult.warnings }, 'env_partial_cleanup');
  }
  if (removed) getLog().info({ envId: env.id, workingPath: env.working_path }, 'env_removed');
  return {
    worktreeRemoved: destroyResult.worktreeRemoved,
    branchDeleted: destroyResult.branchDeleted,
    warnings: destroyResult.warnings,
    ...(!removed ? { skippedReason: INCOMPLETE_REMOVAL_REASON } : {}),
  };
}
