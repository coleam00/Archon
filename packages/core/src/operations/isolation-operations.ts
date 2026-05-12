/**
 * Shared isolation business logic — list, cleanup stale, cleanup merged.
 *
 * CLI and command-handler are thin formatting adapters over these functions.
 */
import { createLogger } from '@archon/paths';
import { toWorktreePath, worktreeExists } from '@archon/git';
import * as isolationDb from '../db/isolation-environments';
import { cleanupStaleWorktrees, cleanupMergedWorktrees } from '../services/cleanup-service';
import type { CleanupOperationResult } from '../services/cleanup-service';

// Lazy logger — NEVER at module scope
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('operations');
  return cachedLog;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface CodebaseEnvironments {
  codebaseId: string;
  repositoryUrl: string | null;
  defaultCwd: string;
  environments: readonly Awaited<ReturnType<typeof isolationDb.listByCodebaseWithAge>>[number][];
}

export interface EnvironmentListData {
  codebases: readonly CodebaseEnvironments[];
  totalEnvironments: number;
  ghostsReconciled: number;
}

export { type CleanupOperationResult } from '../services/cleanup-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reconcile DB state with filesystem — mark environments as destroyed
 * if their worktree path no longer exists on disk.
 */
async function reconcileGhosts(
  envs: readonly {
    id: string;
    working_path: string;
    branch_name: string | null;
    workflow_id: string;
  }[]
): Promise<number> {
  let reconciled = 0;
  for (const env of envs) {
    try {
      const exists = await worktreeExists(toWorktreePath(env.working_path));
      if (!exists) {
        await isolationDb.updateStatus(env.id, 'destroyed');
        getLog().info({ envId: env.id, path: env.working_path }, 'isolation.ghost_reconciled');
        reconciled++;
      }
    } catch (error) {
      const err = error as Error;
      getLog().warn(
        { err, envId: env.id, path: env.working_path },
        'isolation.ghost_reconciliation_failed'
      );
    }
  }
  return reconciled;
}

interface CodebaseInfo {
  id: string;
  repository_url: string | null;
  default_cwd: string;
}

/**
 * Extract unique codebases from active-with-codebase results.
 */
function extractCodebases(
  allEnvs: readonly {
    codebase_id: string;
    codebase_repository_url: string | null;
    codebase_default_cwd: string;
  }[]
): CodebaseInfo[] {
  const map = new Map<string, CodebaseInfo>();
  for (const env of allEnvs) {
    if (!map.has(env.codebase_id)) {
      map.set(env.codebase_id, {
        id: env.codebase_id,
        repository_url: env.codebase_repository_url,
        default_cwd: env.codebase_default_cwd,
      });
    }
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * List all active isolation environments, grouped by codebase.
 * Reconciles ghost entries (worktree missing on disk) before returning.
 */
export async function listEnvironments(): Promise<EnvironmentListData> {
  const allActive = await isolationDb.listAllActiveWithCodebase();
  const codebases = extractCodebases(allActive);

  if (codebases.length === 0) {
    return { codebases: [], totalEnvironments: 0, ghostsReconciled: 0 };
  }

  let totalEnvironments = 0;
  let totalGhosts = 0;
  const result: CodebaseEnvironments[] = [];

  // N+1 pattern: listAllActiveWithCodebase() already returns all rows, but
  // listByCodebaseWithAge() is needed for the days_since_activity field which
  // isn't included in the initial query. A future optimisation could add a
  // single JOIN query returning all fields to eliminate the per-codebase fetches.
  for (const codebase of codebases) {
    const envs = await isolationDb.listByCodebaseWithAge(codebase.id);
    if (envs.length === 0) continue;

    const ghosts = await reconcileGhosts(envs);
    totalGhosts += ghosts;
    const liveEnvs = ghosts > 0 ? await isolationDb.listByCodebaseWithAge(codebase.id) : envs;
    if (liveEnvs.length === 0) continue;

    result.push({
      codebaseId: codebase.id,
      repositoryUrl: codebase.repository_url,
      defaultCwd: codebase.default_cwd,
      environments: liveEnvs,
    });
    totalEnvironments += liveEnvs.length;
  }

  return { codebases: result, totalEnvironments, ghostsReconciled: totalGhosts };
}

/**
 * Cleanup stale worktrees for a codebase.
 * Wraps cleanupStaleWorktrees from cleanup-service.
 */
export async function cleanupStaleEnvironments(
  codebaseId: string,
  mainPath: string
): Promise<CleanupOperationResult> {
  // First reconcile ghost entries
  const allActive = await isolationDb.listAllActiveWithCodebase();
  const codebaseEnvs = allActive.filter(e => e.codebase_id === codebaseId);
  await reconcileGhosts(codebaseEnvs);

  return cleanupStaleWorktrees(codebaseId, mainPath);
}

/**
 * Cleanup merged worktrees for a codebase.
 * Wraps cleanupMergedWorktrees from cleanup-service.
 */
export async function cleanupMergedEnvironments(
  codebaseId: string,
  mainPath: string,
  options: { includeClosed?: boolean } = {}
): Promise<CleanupOperationResult> {
  return cleanupMergedWorktrees(codebaseId, mainPath, options);
}
