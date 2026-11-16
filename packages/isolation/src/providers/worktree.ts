/**
 * Worktree Provider - Git worktree-based isolation
 *
 * Default isolation provider using git worktrees. Each lifecycle lives in
 * `./worktree/`: creation, finding and adopting, destruction, and branch
 * handling.
 */

import { toWorktreePath, worktreeExists } from '@archon/git';
import type {
  DestroyResult,
  IIsolationProvider,
  IsolationRequest,
  RepoConfigLoader,
  WorktreeCreateConfig,
  WorktreeCreationEnvironment,
  WorktreeDestroyOptions,
  WorktreeSetupExecutor,
} from '../types';
import { generateBranchName } from './worktree/branches';
import { createWorktreeEnvironment } from './worktree/create';
import { destroyWorktree } from './worktree/destroy';
import { worktreePathFor } from './worktree/location';

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
