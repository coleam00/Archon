/**
 * Shared isolation business logic — list and cleanup merged.
 *
 * CLI and command-handler are thin formatting adapters over these functions.
 */
import { getRegisteredPlatformPolicies, unknownPlatformReason } from '../platforms/registry';
import { createLogger } from '@archon/paths';
import { lstat } from 'node:fs/promises';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import * as isolationDb from '../db/isolation-environments';
import { cleanupMergedWorktrees, type MergedCleanupResult } from '../services/cleanup/merged-sweep';
import { getLiveRunBlocker } from '../services/cleanup/run-lock';

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
  environments: readonly (Awaited<ReturnType<typeof isolationDb.listByCodebaseWithAge>>[number] & {
    cleanupSkipReason?: string;
  })[];
}

export interface EnvironmentListData {
  codebases: readonly CodebaseEnvironments[];
  totalEnvironments: number;
  ghostsReconciled: number;
}

export {
  type CleanupOperationResult,
  type MergedCleanupResult,
} from '../services/cleanup/merged-sweep';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reconcile DB state with filesystem — mark environments as destroyed
 * if their worktree path no longer exists on disk.
 *
 * An env a run can still claim is left active even with its directory gone: marking
 * it destroyed invalidates that run's resume handle, and this runs from
 * `listEnvironments()` ahead of the per-item live-run guard in the `isolation
 * cleanup` commands, so a row ghosted here never reaches that guard. A failed run
 * stays here too: no outcome is judged here, and those per-item sweeps release
 * its lock once they settle one. The env stays visible in `isolation list` with
 * its missing path, which is the operator's signal to act.
 */
async function reconcileGhosts(envs: readonly IsolationEnvironmentRow[]): Promise<number> {
  let reconciled = 0;
  for (const env of envs) {
    if (env.provider !== 'worktree') continue;
    const reason = unknownPlatformReason(env.created_by_platform);
    if (reason) {
      getLog().warn({ envId: env.id, reason }, 'isolation.cleanup_skipped');
      continue;
    }
    try {
      const exists = await lstat(env.working_path).then(
        () => true,
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      );
      if (!exists) {
        const liveRun = await getLiveRunBlocker(env.id);
        if (liveRun) {
          getLog().info(
            {
              envId: env.id,
              path: env.working_path,
              runId: liveRun.runId,
              runStatus: liveRun.runStatus,
            },
            'isolation.ghost_kept_for_live_run'
          );
          continue;
        }
        await isolationDb.markWorktreeDestroyed(env);
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
  getRegisteredPlatformPolicies();
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
      environments: liveEnvs.map(env => {
        const reason = unknownPlatformReason(env.created_by_platform);
        return reason ? { ...env, cleanupSkipReason: reason } : env;
      }),
    });
    totalEnvironments += liveEnvs.length;
  }

  return { codebases: result, totalEnvironments, ghostsReconciled: totalGhosts };
}

/**
 * Cleanup merged worktrees for a codebase.
 * Wraps cleanupMergedWorktrees from the merged sweep.
 */
export async function cleanupMergedEnvironments(
  codebaseId: string,
  mainPath: string,
  options: { includeClosed?: boolean } = {}
): Promise<MergedCleanupResult> {
  return cleanupMergedWorktrees(codebaseId, mainPath, options);
}
