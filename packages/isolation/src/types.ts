/**
 * Isolation Provider Abstraction Types
 *
 * Platform-agnostic interfaces for workflow isolation mechanisms.
 * Git worktrees are the default implementation, but the abstraction
 * enables future strategies (containers, VMs).
 */

import type { RepoPath, BranchName } from '@archon/git';

// --- Provider Types ---

export type IsolationProviderType = 'worktree' | 'container' | 'vm' | 'remote';

export type IsolationWorkflowType = 'issue' | 'pr' | 'review' | 'thread' | 'task';

export type EnvironmentStatus = 'active' | 'destroyed';

// --- Isolation Request Types (Discriminated Union) ---

interface IsolationRequestBase {
  /** Database ID for the codebase */
  codebaseId: string;

  /**
   * Codebase name in "owner/repo" format.
   * When present, used to resolve the project-scoped worktree path directly,
   * even for locally-registered repos whose path doesn't start with workspacesPath.
   */
  codebaseName?: string;

  /**
   * Absolute, resolved filesystem path to the main repository checkout.
   *
   * "Canonical" means the real path with symlinks resolved and `~` expanded
   * (e.g., `/home/user/.archon/workspaces/owner/repo/source`). This must
   * point to the primary git checkout, not a worktree, because git worktree
   * operations (add, remove, list) must be executed from the main repo.
   *
   * Use `getCanonicalRepoPath()` to resolve any path (including worktree
   * paths) back to the canonical repo path.
   */
  canonicalRepoPath: RepoPath;

  description?: string;
}

export interface IssueIsolationRequest extends IsolationRequestBase {
  workflowType: 'issue';
  identifier: string;
}

export interface PRIsolationRequest extends IsolationRequestBase {
  workflowType: 'pr';
  identifier: string;
  /** The actual branch name of the PR (required for PR workflows) */
  prBranch: BranchName;
  /** Head commit SHA for reproducible reviews */
  prSha?: string;
  /** True if PR is from a fork (affects branch strategy) */
  isForkPR: boolean;
}

export interface ReviewIsolationRequest extends IsolationRequestBase {
  workflowType: 'review';
  identifier: string;
}

export interface ThreadIsolationRequest extends IsolationRequestBase {
  workflowType: 'thread';
  /** Thread ID (will be hashed for branch name) */
  identifier: string;
}

export interface TaskIsolationRequest extends IsolationRequestBase {
  workflowType: 'task';
  /** Task identifier (will be slugified for branch name, max 50 chars) */
  identifier: string;
  /** Optional branch to use as start point for new task branch creation */
  fromBranch?: BranchName;
}

export type IsolationRequest =
  | IssueIsolationRequest
  | PRIsolationRequest
  | ReviewIsolationRequest
  | ThreadIsolationRequest
  | TaskIsolationRequest;

// --- Isolated Environment Types ---

export interface AdoptedWorktreeMetadata {
  adopted: true;
  adoptedFrom?: 'path' | 'branch';
  request?: IsolationRequest;
}

export interface CreatedWorktreeMetadata {
  adopted: false;
  request?: IsolationRequest;
}

export type WorktreeMetadata = AdoptedWorktreeMetadata | CreatedWorktreeMetadata;

interface IsolatedEnvironmentBase {
  /** For worktrees, this is the filesystem path */
  id: string;
  workingPath: string;
  status: EnvironmentStatus;
  /**
   * For worktrees, set to current time since git doesn't store creation timestamps.
   * For accurate timestamps, store in database.
   */
  createdAt: Date;
  /** Non-fatal warnings to surface to the user after successful creation */
  warnings?: string[];
}

export interface WorktreeEnvironment extends IsolatedEnvironmentBase {
  provider: 'worktree';
  branchName: BranchName;
  metadata: WorktreeMetadata;
}

export type IsolatedEnvironment = WorktreeEnvironment;

// --- Provider Interface ---

export interface DestroyOptions {
  force?: boolean;
}

export interface WorktreeDestroyOptions extends DestroyOptions {
  branchName?: BranchName;
  /** Required for branch cleanup if worktree path doesn't exist */
  canonicalRepoPath?: RepoPath;
  /** Delete the remote branch (best-effort, e.g., after PR merge) */
  deleteRemoteBranch?: boolean;
  /** Git remote name for remote branch deletion (default: 'origin') */
  remote?: string;
}

/**
 * Communicates partial failures from best-effort cleanup operations.
 * All fields reflect what actually happened during destruction.
 */
export interface DestroyResult {
  worktreeRemoved: boolean;
  /** null = no branch specified */
  branchDeleted: boolean | null;
  /** null = not requested */
  remoteBranchDeleted: boolean | null;
  directoryClean: boolean;
  warnings: string[];
}

/**
 * Provider interface for isolation strategies.
 *
 * Manages the lifecycle of isolated development environments:
 * create -> use -> destroy. Git worktrees are the default (and currently
 * only) implementation.
 *
 * Error contract:
 * - `create` throws on failure (caller should surface to user)
 * - `destroy` returns a `DestroyResult` with partial-failure details
 * - `get` returns null if not found, throws on unexpected I/O errors
 * - `healthCheck` returns false if missing, throws on permission errors
 */
export interface IIsolationProvider {
  readonly providerType: IsolationProviderType;

  create(request: IsolationRequest): Promise<IsolatedEnvironment>;

  /**
   * Best-effort cleanup. Throws only for unexpected errors (permissions, git failures).
   */
  destroy(envId: string, options?: DestroyOptions | WorktreeDestroyOptions): Promise<DestroyResult>;

  get(envId: string): Promise<IsolatedEnvironment | null>;

  /** For worktrees, codebaseId is the canonical repo path */
  list(codebaseId: string): Promise<IsolatedEnvironment[]>;

  /** Take ownership of externally-created environments (optional, for skill-app symbiosis) */
  adopt?(path: string): Promise<IsolatedEnvironment | null>;

  healthCheck(envId: string): Promise<boolean>;
}

// --- Type Guards ---

export function isPRIsolationRequest(request: IsolationRequest): request is PRIsolationRequest {
  return request.workflowType === 'pr';
}

// --- Isolation Hints & Block Reasons ---

export interface IsolationHints {
  workflowType?: IsolationWorkflowType;
  workflowId?: string;

  // PR-specific
  prBranch?: BranchName;
  prSha?: string;
  isForkPR?: boolean;
  prFetchFailed?: boolean;

  // Task-specific
  /** Start-point branch for new task worktree creation. Only consumed when workflowType === 'task'. */
  fromBranch?: BranchName;

  /** Expected base branch for this workflow. When set, reused worktrees are validated with merge-base. */
  baseBranch?: BranchName;

  // Cross-reference hints
  linkedIssues?: number[];
  linkedPRs?: number[];

  // Adoption hints
  suggestedBranch?: string;
}

export type IsolationBlockReason = 'creation_failed';

// --- Database Types ---

export interface IsolationEnvironmentRow {
  id: string;
  codebase_id: string;
  workflow_type: IsolationWorkflowType;
  workflow_id: string;
  provider: IsolationProviderType;
  working_path: string;
  branch_name: string;
  status: EnvironmentStatus;
  created_at: Date;
  created_by_platform: string | null;
  metadata: Record<string, unknown>;
}

// --- Config Injection ---

export interface WorktreeCreateConfig {
  baseBranch?: string;
  copyFiles?: string[];
  /**
   * Initialize git submodules in the worktree. Defaults to enabled — a worktree
   * with uninitialized submodules is a silent broken state for monorepos.
   * Set to `false` to opt out. No-op when `.gitmodules` is absent.
   */
  initSubmodules?: boolean;
  /**
   * Per-project relative path (from repo root) where worktrees should be created.
   * When set, worktrees live at `<repoRoot>/<path>/<branch>` with `repo-local` layout.
   * Highest priority in path resolution — overrides project-scoped and global defaults.
   *
   * Must be a safe relative path: no leading `/`, no `..` segments, non-empty after trim.
   * Validation is enforced in `WorktreeProvider.getWorktreePath()` (fails fast with a
   * clear error rather than silently falling back).
   *
   * Sourced from `.archon/config.yaml > worktree.path` in the repo.
   * @example '.worktrees'
   */
  path?: string;
  /**
   * Git remote name to use for fetch/push operations.
   *
   * When set, all git operations (fetch, push, branch tracking) use this
   * remote instead of 'origin'. Useful for repos with multiple remotes or
   * non-standard naming conventions.
   *
   * When omitted, auto-detected via `getDefaultRemote()`:
   *   1. 'origin' if it exists
   *   2. The sole remote if only one is configured
   *   3. Fails with actionable error if ambiguous
   *
   * Sourced from `.archon/config.yaml > worktree.remote` in the repo.
   * @example 'upstream'
   */
  remote?: string;
}

export type RepoConfigLoader = (repoPath: string) => Promise<WorktreeCreateConfig | null>;

// --- Worktree Status Breakdown ---

/**
 * Detailed worktree status breakdown for a codebase.
 * Used for status display and cleanup messaging.
 */
export interface WorktreeStatusBreakdown {
  total: number;
  merged: number;
  stale: number;
  active: number;
  mergedEnvs: { id: string; branchName: string }[];
  staleEnvs: { id: string; branchName: string; daysInactive: number }[];
  activeEnvs: { id: string; branchName: string }[];
}

// --- Store Types ---

export interface CreateEnvironmentParams {
  codebase_id: string;
  workflow_type: IsolationWorkflowType;
  workflow_id: string;
  provider?: IsolationProviderType;
  working_path: string;
  branch_name: BranchName;
  created_by_platform?: string;
  metadata?: Record<string, unknown>;
}

// --- Resolver Types ---

export interface ResolveRequest {
  existingEnvId: string | null;
  codebase: {
    id: string;
    defaultCwd: string;
    name: string;
  } | null;
  hints?: IsolationHints;
  platformType: string;
}

export type ResolutionMethod =
  | { type: 'existing' }
  | { type: 'workflow_reuse' }
  | { type: 'linked_issue_reuse'; issueNumber: number }
  | { type: 'branch_adoption'; branch: string }
  | { type: 'created'; autoCleanedCount?: number };

export type IsolationResolution =
  | {
      status: 'resolved';
      env: IsolationEnvironmentRow;
      cwd: string;
      method: ResolutionMethod;
      warnings?: string[];
    }
  | { status: 'stale_cleaned'; previousEnvId: string }
  | { status: 'none'; cwd: string }
  | { status: 'blocked'; reason: IsolationBlockReason; userMessage: string };
