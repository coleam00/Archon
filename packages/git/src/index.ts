export { GitFailure } from './errors';
export type { GitFailureKind } from './errors';
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
export { execFileAsync, mkdirAsync, resolveBashPath } from './exec';

// Worktree operations
export {
  getWorktreeBase,
  isProjectScopedWorktreeBase,
  worktreeExists,
  listWorktrees,
  findWorktreeByBranch,
  isWorktreePath,
  removeWorktree,
  unlockWorktree,
  readWorktreeLock,
  refreshWorktreeIndex,
  getCanonicalRepoPath,
  getGitCheckoutIdentity,
  CanonicalRepoPathUnavailableError,
  verifyWorktreeOwnership,
  isWorktreeRegistered,
  readWorktreeRegistration,
  isSameWorktreePath,
  toNativeWorktreePath,
} from './worktree';
export type {
  WorktreeLayout,
  WorktreeBaseOverride,
  GitCheckoutIdentity,
  WorktreeLock,
} from './worktree';

// Branch operations
export {
  getDefaultBranch,
  getUniqueCommitCount,
  getCurrentBranch,
  getCurrentBranchStrict,
  localBranchExists,
  countCommitsAhead,
  countCommitsMissingFromRemotes,
  checkout,
  hasUncommittedChanges,
  hasUncommittedChangesStrict,
  commitAllChanges,
  isBranchMerged,
  isPatchEquivalent,
  isAncestorOf,
  isRevCoveredBy,
  getLastCommitDate,
} from './branch';

// Forge detection
export { detectForge } from './forge';
export type { ForgeType, ForgeInfo } from './forge';
export { GITHUB_COM_HOST, parseGitHubHost, readGitHubHost, resolveGitHubHost } from './github-host';
export type { GitHubHost } from './github-host';

// Repository operations
export {
  findRepoRoot,
  getDefaultRemote,
  getRemoteUrl,
  listChildRepos,
  syncWorkspace,
  fetchWithRetry,
  cloneRepository,
  validateCloneUrl,
  syncRepository,
  addSafeDirectory,
} from './repo';
export type { CloneCredentials, CloneRepositoryOptions } from './repo';
export { trustRegisteredPath } from './registration-trust';

export {
  inspectRemoteBranches,
  validateBranchName,
  ConfiguredBaseBranchNotFoundError,
  InvalidBaseBranchError,
} from './remote-branches';
export type { RemoteBranchTarget, RemoteBranches } from './remote-branches';

export { githubTokenCredentials } from './credentials';
