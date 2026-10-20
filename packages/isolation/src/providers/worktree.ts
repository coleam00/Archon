/**
 * Worktree Provider - Git worktree-based isolation
 *
 * Default isolation provider using git worktrees. Each lifecycle lives in
 * `./worktree/`: creation, finding and adopting, destruction, and branch
 * handling.
 */

import {
  isSameWorktreePath,
  listWorktrees,
  toBranchName,
  toRepoPath,
  toWorktreePath,
  worktreeExists,
} from '@archon/git';
import type { RepoPath, WorktreeInfo } from '@archon/git';
import type {
  DestroyResult,
  IIsolationProvider,
  IsolatedEnvironment,
  IsolationRequest,
  RepoConfigLoader,
  WorktreeCreateConfig,
  WorktreeCreationEnvironment,
  WorktreeDestroyOptions,
  WorktreeSetupExecutor,
} from '../types';
import { adoptPath } from './worktree/adopt';
import { generateBranchName } from './worktree/branches';
import { createWorktreeEnvironment } from './worktree/create';
import { destroyWorktree } from './worktree/destroy';
import { worktreePathFor } from './worktree/location';
import { getGitCommandAnchors, getLog } from './worktree/shared';

export { resolveRepoLocalOverride } from './worktree/location';

export class WorktreeProvider implements IIsolationProvider {
  readonly providerType = 'worktree';

  constructor(
    private loadConfig: RepoConfigLoader = () => Promise.resolve(null),
    private setupExecutor?: WorktreeSetupExecutor
  ) {}

  /**
   * Create an isolated environment using git worktrees.
   *
   * Config is loaded once; parsed provisioning settings are validated before mutation.
   */
  async create(
    request: IsolationRequest,
    setupExecutor = this.setupExecutor
  ): Promise<WorktreeCreationEnvironment> {
    return createWorktreeEnvironment(request, this.loadConfig, setupExecutor);
  }

  /**
   * Destroy an isolated environment
   *
   * @param envId - The worktree path (for WorktreeProvider, envId IS the filesystem path)
   * @param options - Cleanup options:
   *   - force: Force removal even with uncommitted changes
   *   - branchName: Delete the associated branch after worktree removal
   *   - canonicalRepoPath: Expected repository, required for present-checkout removal
   *   - creationId: Expected creation proof for ordinary present-checkout removal
   *
   * Cleanup behavior:
   * - Present checkout: requires repository registration and matching creation proof
   * - Git removal failures propagate; surviving directories are retained and reported
   * - Branch deletion: Best-effort, logs but doesn't fail
   *
   * **IMPORTANT: Branch cleanup limitation**
   * If `branchName` is provided but the worktree path no longer exists AND
   * `canonicalRepoPath` is not provided, branch deletion will be SKIPPED with a warning.
   * The result will have `branchDeleted: false` and a warning in `warnings`.
   * To ensure branch cleanup when the worktree may already be removed,
   * always provide `canonicalRepoPath`.
   *
   * Throws on unproven ownership, permissions, and Git removal failures.
   */
  async destroy(envId: string, options?: WorktreeDestroyOptions): Promise<DestroyResult> {
    return destroyWorktree(envId, options);
  }

  /**
   * Get environment by ID (worktree path)
   *
   * Note: createdAt is set to current time since git worktrees don't store
   * creation timestamps. For accurate timestamps, store metadata in the
   * database when creating environments.
   *
   * Returns null if worktree doesn't exist. May throw if underlying git
   * operations fail with unexpected errors.
   */
  async get(envId: string): Promise<IsolatedEnvironment | null> {
    const worktreePath = envId;

    if (!(await worktreeExists(toWorktreePath(worktreePath)))) {
      return null;
    }

    // Get branch name from worktree
    let repoPath: RepoPath;
    let worktrees: WorktreeInfo[];
    try {
      repoPath = (await getGitCommandAnchors(worktreePath)).active;
      worktrees = await listWorktrees(repoPath);
    } catch (error) {
      getLog().error({ err: error, worktreePath }, 'worktree_query_failed');
      throw error;
    }

    const wt = worktrees.find(w => isSameWorktreePath(w.path, worktreePath));

    // If worktree exists on disk but not in git's list, it's a corrupted state
    if (!wt) {
      getLog().warn({ worktreePath, repoPath }, 'worktree_not_registered');
      return null;
    }

    return {
      id: envId,
      provider: 'worktree',
      workingPath: worktreePath,
      branchName: toBranchName(wt.branch),
      status: 'active',
      createdAt: new Date(), // Cannot determine actual creation time
      metadata: { provenance: 'observed', adopted: false },
    };
  }

  /**
   * List all environments for a codebase
   */
  async list(codebaseId: string): Promise<IsolatedEnvironment[]> {
    // codebaseId is the canonical repo path for worktrees
    const repoPath = toRepoPath(codebaseId);
    const worktrees = await listWorktrees(repoPath);

    // Filter out main repo (first worktree is typically the main checkout)
    return worktrees
      .filter(wt => wt.path !== (repoPath as string))
      .map(wt => ({
        id: wt.path,
        provider: 'worktree' as const,
        workingPath: wt.path,
        branchName: toBranchName(wt.branch),
        status: 'active' as const,
        createdAt: new Date(),
        metadata: { provenance: 'observed', adopted: false },
      }));
  }

  /**
   * Adopt an existing worktree (for skill-app symbiosis)
   *
   * Returns null if:
   * - Path doesn't exist or isn't a valid worktree
   * - Path is not a git repository
   * - Worktree exists on disk but isn't registered with git (corrupted state)
   *
   * Throws for unexpected errors (permission denied, I/O failures).
   */
  async adopt(path: string): Promise<IsolatedEnvironment | null> {
    return adoptPath(path);
  }

  /**
   * Check if environment exists and is healthy
   *
   * Delegates to `worktreeExists()` which checks both path and .git file access.
   *
   * @throws Error - May throw for permission denied or other I/O errors.
   *                 Only returns false for missing paths (ENOENT).
   */
  async healthCheck(envId: string): Promise<boolean> {
    return worktreeExists(toWorktreePath(envId));
  }

  /**
   * Generate semantic branch name based on workflow type
   *
   * For same-repo PRs: Use the actual PR branch name
   * For fork PRs: Use synthetic pr-N-review branch
   */
  generateBranchName(request: IsolationRequest): string {
    return generateBranchName(request);
  }

  /**
   * Get worktree path for a request, honoring the per-repo override if set
   * (see `worktreeBaseFor()` in `./worktree/location.ts`). Unsafe `config.path` values throw rather than
   * silently falling back to the default layout.
   */
  getWorktreePath(
    request: IsolationRequest,
    branchName: string,
    config?: WorktreeCreateConfig | null
  ): string {
    return worktreePathFor(request, branchName, config);
  }
}
