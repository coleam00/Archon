/**
 * Child-isolation resolver factory (#2121 slice 2, PR-A).
 *
 * Constructs the {@link ChildIsolationResolver} port the workflow engine calls once
 * per `workflow:` child whose node declares `isolation: 'worktree'`. Lives in
 * `@archon/core` — the layer that already depends on BOTH `@archon/workflows` (the
 * port TYPE) and `@archon/isolation` (`WorktreeProvider`) — so the port stays
 * isolation-free (`@archon/workflows` never imports `@archon/isolation`) AND the
 * five injection sites (CLI + orchestrator dispatch/resume/background) share one
 * implementation instead of duplicating the worktree-create wiring.
 *
 * Mirrors the top-level CLI worktree creation (`packages/cli/src/commands/workflow.ts`):
 * `WorktreeProvider.create({ workflowType: 'task', … })` for a fresh
 * `archon/task-<parent>-child-<i>` branch, then registers the
 * `isolation_environments` row so standard `isolation list`/`cleanup`/`complete`
 * hygiene applies to child worktrees.
 */

import type {
  ChildIsolationResolver,
  ChildIsolationRequest,
  ChildIsolationResult,
} from '@archon/workflows/executor';
import { getIsolationProvider } from '@archon/isolation';
import * as git from '@archon/git';
import { createLogger } from '@archon/paths';
import * as isolationDb from '../db/isolation-environments';

/** Codebase-scoped context captured when the caller builds the resolver. */
export interface ChildWorktreeResolverConfig {
  /** Codebase the child worktrees belong to (attribution + worktree pathing). */
  codebaseId: string;
  /** "owner/repo" name — lets the provider resolve the project-scoped worktree path. */
  codebaseName: string;
  /** Canonical checkout path of the main repo (the codebase's `default_cwd`). */
  canonicalRepoPath: string;
  /** Base-branch fallback for new child worktrees (the codebase's `default_branch`). */
  baseBranch?: string;
  /** Platform recorded on the `isolation_environments` row (e.g. `'cli'`, `'web'`). */
  createdByPlatform: string;
  /** Archon user id recorded as the environment creator (attribution). */
  createdByUserId?: string;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflows.child-isolation');
  return cachedLog;
}

/**
 * Build a {@link ChildIsolationResolver} bound to one codebase. `resolve()` creates
 * a per-child worktree + branch (`archon/task-<parent>-child-<i>`) and registers it.
 * Throws (surfaced by the engine as a failed node outcome) when the worktree cannot
 * be created — never returns the shared checkout as a fallback.
 */
export function createChildWorktreeResolver(
  config: ChildWorktreeResolverConfig
): ChildIsolationResolver {
  return {
    async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
      const childIndex = req.childIndex ?? 0;
      // 8-char parent prefix keeps the slugified branch under the provider's cap
      // while staying unique per parent run; `-child-<i>` disambiguates fan-out
      // siblings (PR-C).
      const identifier = `${req.parentRun.id.slice(0, 8)}-child-${String(childIndex)}`;

      const provider = getIsolationProvider();
      const isolatedEnv = await provider.create({
        workflowType: 'task',
        identifier,
        baseBranch: config.baseBranch ? git.toBranchName(config.baseBranch) : undefined,
        codebaseId: config.codebaseId,
        codebaseName: config.codebaseName,
        canonicalRepoPath: git.toRepoPath(config.canonicalRepoPath),
        description: `sub-run child ${String(childIndex)} (node ${req.nodeId})`,
      });

      // Register the env so `isolation list`/`cleanup`/`complete <branch>` see it.
      const envRecord = await isolationDb.create({
        codebase_id: config.codebaseId,
        workflow_type: 'task',
        workflow_id: identifier,
        provider: 'worktree',
        working_path: isolatedEnv.workingPath,
        branch_name: isolatedEnv.branchName,
        created_by_platform: config.createdByPlatform,
        ...(config.createdByUserId ? { created_by_user_id: config.createdByUserId } : {}),
        metadata: { parent_run_id: req.parentRun.id, child_index: childIndex },
      });

      getLog().info(
        {
          parentRunId: req.parentRun.id,
          nodeId: req.nodeId,
          childIndex,
          branch: isolatedEnv.branchName,
          envId: envRecord.id,
        },
        'workflow.child_worktree_created'
      );

      return {
        cwd: isolatedEnv.workingPath,
        envId: envRecord.id,
        branchName: isolatedEnv.branchName,
      };
    },
  };
}
