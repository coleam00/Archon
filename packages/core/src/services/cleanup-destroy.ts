import {
  getIsolationProvider,
  readWorktreeBranchCreated,
  readWorktreeCreationId,
  type IsolationEnvironmentRow,
} from '@archon/isolation';
import { createLogger } from '@archon/paths';
import { toBranchName, type RepoPath } from '@archon/git';
import type { RemoveEnvironmentOptions, RemoveEnvironmentResult } from './cleanup-service';

export async function destroyEnvironment(
  env: IsolationEnvironmentRow,
  options: RemoveEnvironmentOptions | undefined,
  canonicalRepoPath: RepoPath | undefined,
  remote: string | undefined,
  markDestroyed: () => Promise<void>
): Promise<RemoveEnvironmentResult> {
  const envId = env.id;
  const provider = getIsolationProvider();
  const log = createLogger('cleanup');
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
    deleteRemoteBranch: options?.deleteRemoteBranch,
    remote,
  });

  if (destroyResult.warnings.length > 0) {
    log.warn({ envId, warnings: destroyResult.warnings }, 'env_partial_cleanup');
  }

  if (!destroyResult.worktreeRemoved || !destroyResult.directoryClean) {
    return {
      worktreeRemoved: destroyResult.worktreeRemoved,
      branchDeleted: destroyResult.branchDeleted,
      warnings: destroyResult.warnings,
      skippedReason: 'filesystem removal incomplete; environment remains active',
    };
  }
  await markDestroyed();

  log.info({ envId, workingPath: env.working_path }, 'env_removed');

  return {
    worktreeRemoved: destroyResult.worktreeRemoved,
    branchDeleted: destroyResult.branchDeleted,
    warnings: destroyResult.warnings,
  };
}
