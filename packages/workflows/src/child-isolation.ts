/**
 * Per-child isolation resolver port for `workflow:` sub-run nodes (#2121 slice 2,
 * PR-A).
 *
 * A STRUCTURAL port — the exact analogue of the container write-back port in
 * `./container-context.ts`. It lives in `@archon/workflows` and imports ONLY local
 * types (no `@archon/isolation`), so the engine can drive per-child worktree
 * creation without depending on that package. The IMPLEMENTATION is constructed by
 * the caller (CLI / orchestrator, via `@archon/core`) over `WorktreeProvider` and
 * injected through {@link ExecuteWorkflowOptions.resolveChildIsolation}.
 *
 * The one real departure from the container precedent: the container backend is
 * resolved ONCE in the caller before `executeWorkflow` and passed in as a
 * pre-built context. Per-child isolation cannot be — the child count is a RUNTIME
 * property (fan-out, PR-C) and children spawn deep inside the DAG — so the port is
 * a RESOLVER the engine calls once per child at spawn time.
 */

import type { WorkflowRun } from './schemas';

/**
 * Request for a per-child isolated checkout, built by the engine at child-spawn
 * time. The resolver closure supplies the codebase-specific bits (canonical repo
 * path, base branch, codebase name) it captured when the caller constructed it;
 * the request carries only what varies per child.
 */
export interface ChildIsolationRequest {
  /** The parent run — its id seeds the child's branch/worktree identifier. */
  parentRun: WorkflowRun;
  /** The `workflow:` node id spawning this child (used for the worktree description). */
  nodeId: string;
  /**
   * Fan-out index (PR-C); a single (non-fan-out) child is index 0. Included in the
   * branch identifier so N fan-out children get distinct worktrees.
   */
  childIndex?: number;
  /** Codebase id inherited from the parent run (attribution + resolver guard). */
  codebaseId?: string;
}

/**
 * Result of resolving a per-child isolated checkout. Deliberately
 * provider-agnostic: a future container-per-child backend (#2060) implements the
 * same port, returning a container `cwd`/`envId` instead of a worktree path.
 */
export interface ChildIsolationResult {
  /** The per-child checkout path — the child run's `working_path` and execution cwd. */
  cwd: string;
  /** The registered isolation-environment row id (so the child appears in `isolation list`). */
  envId: string;
  /** The branch created for the child (e.g. `archon/task-<parent>-child-0`). */
  branchName: string;
}

/**
 * The single method the engine drives to obtain a per-child isolated checkout.
 * Implementations register an `isolation_environments` row so standard
 * `isolation list`/`cleanup`/`complete <branch>` hygiene applies to child
 * worktrees. May reject (folder-project codebase, git failure) — the engine
 * surfaces the rejection as a failed node outcome, never a silent shared-checkout
 * fallback (a shared parallel write is the exact collision worktree isolation
 * prevents).
 */
export interface ChildIsolationResolver {
  resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult>;
}
