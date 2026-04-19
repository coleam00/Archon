// Types
export type {
  RepoPath,
  BranchName,
  WorktreePath,
  GitResult,
  GitError,
  WorkspaceSyncResult,
  WorktreeInfo,
} from './types';
export { toRepoPath, toBranchName, toWorktreePath } from './types';

// Process and filesystem wrappers
export { execFileAsync, mkdirAsync } from './exec';

// GitHub CLI auth policy
export {
  GITHUB_CLI_TOKEN_ENV_VARS,
  stripGitHubCliTokens,
  parseGitHubHostFromRemoteUrl,
  getGitHubHostForRepo,
  resolveGitHubCliAuthDecision,
  execGhWithAuthPolicy,
} from './github-cli-auth';
export type {
  GitHubCliAuthPreference,
  GitHubCliAuthSource,
  GitHubCliAuthDecision,
  GitHubCliAuthOptions,
  ExecGhWithAuthOptions,
  ExecGhWithAuthResult,
} from './github-cli-auth';

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
