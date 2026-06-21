// Types
export type {
  RepoPath,
  BranchName,
  WorktreePath,
  GitResult,
  GitError,
  WorkspaceSyncMode,
  WorkspaceSyncState,
  WorkspaceSyncResult,
  WorktreeInfo,
} from './types';
export { toRepoPath, toBranchName, toWorktreePath } from './types';

// Process and filesystem wrappers
export { execFileAsync, mkdirAsync } from './exec';

// Worktree operations
export {
  extractOwnerRepo,
  getWorktreeBase,
  isProjectScopedWorktreeBase,
  worktreeExists,
  listWorktrees,
  findWorktreeByBranch,
  isWorktreePath,
  removeWorktree,
  getCanonicalRepoPath,
  verifyWorktreeOwnership,
} from './worktree';
export type { WorktreeLayout, WorktreeBaseOverride } from './worktree';

// Branch operations
export {
  getDefaultBranch,
  checkout,
  hasUncommittedChanges,
  commitAllChanges,
  isBranchMerged,
  isPatchEquivalent,
  isAncestorOf,
  getLastCommitDate,
} from './branch';

// Repository operations
export {
  findRepoRoot,
  getRemoteUrl,
  syncWorkspace,
  cloneRepository,
  syncRepository,
  addSafeDirectory,
} from './repo';

// Manual failed-node retry ref helpers
export {
  buildCheckpointRef,
  buildRetrySafetyRef,
  assertGitRepository,
  validateGitRef,
  verifyCommitRef,
  hasTrackedChanges,
  createTrackedChangesCommit,
  upsertCheckpointRef,
  createRetrySafetyRef,
  resetTrackedFilesToCommit,
  deleteRetryRefsByRunId,
} from './retry-refs';
export type {
  RetryRefIdentity,
  CheckpointRefIdentity,
  RetrySafetyRefIdentity,
  RetryRefResult,
  DeleteRetryRefsResult,
} from './retry-refs';
