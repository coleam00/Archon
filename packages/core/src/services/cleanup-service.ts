/**
 * Cleanup service for isolation environments
 * Handles removal triggered by events, schedule, or commands.
 *
 * The cleanup jobs live under ./cleanup/. The scheduled and stale sweeps stay
 * here with the environment configuration they read, which is read once, when
 * this module initializes.
 */
import type { WorktreeStatusBreakdown } from '@archon/isolation';
import { isBranchMerged, isPatchEquivalent, toBranchName, toRepoPath } from '@archon/git';
import type { PrLookup } from '@archon/isolation';
import {
  getRegisteredPlatformPolicies,
  retainsWorkspace,
  unknownPlatformReason,
} from '../platforms/registry';
import * as isolationEnvDb from '../db/isolation-environments';
import * as conversationDb from '../db/conversations';
import * as sessionDb from '../db/sessions';
import { SessionNotFoundError } from '../db/sessions';
import { ConversationNotFoundError } from '../types';
import { getLog } from './cleanup/log';
import { resolveRepoGitContext } from './cleanup/merge-verdict';
import { checkRemoval, getLiveRunBlocker } from './cleanup/run-lock';
import { removeEnvironment } from './cleanup/remove-environment';
import { reapContainerEnvironments, type ContainerCleanupReport } from './cleanup/containers';
import { recordCleanupRemoval, type CleanupOperationResult } from './cleanup/merged-sweep';
import { sweepScheduledEnvironment, type CleanupReport } from './cleanup/scheduled-sweep';

function readPositiveIntegerEnv(
  name: string,
  defaultValue: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const parsed = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    const limit = maximum === Number.MAX_SAFE_INTEGER ? '' : `; maximum is ${String(maximum)}`;
    throw new Error(
      `${name} must be a positive integer; received ${JSON.stringify(value)}${limit}`
    );
  }
  return parsed;
}

const STALE_THRESHOLD_DAYS = readPositiveIntegerEnv('STALE_THRESHOLD_DAYS', 14);
// Runtime timers clamp delays above the signed 32-bit millisecond limit to 1 ms.
const CLEANUP_INTERVAL_HOURS = readPositiveIntegerEnv(
  'CLEANUP_INTERVAL_HOURS',
  6,
  Math.floor(2_147_483_647 / (60 * 60 * 1000))
);
const SESSION_RETENTION_DAYS = readPositiveIntegerEnv('SESSION_RETENTION_DAYS', 30);

// Export configuration for use by other modules
export { STALE_THRESHOLD_DAYS, SESSION_RETENTION_DAYS };

// Module-level variable for scheduler
let cleanupIntervalId: NodeJS.Timeout | null = null;

/** Reap orphaned container environments older than `daysStale`; see reapContainerEnvironments. */
export function cleanupContainerEnvironments(
  daysStale = STALE_THRESHOLD_DAYS
): Promise<ContainerCleanupReport> {
  return reapContainerEnvironments(daysStale);
}

/**
 * Called when a platform conversation is closed (e.g., GitHub issue/PR closed)
 * Cleans up the associated isolation environment unless a workflow run can still
 * claim it. Conversation references are data, not locks (#2868).
 */
export async function onConversationClosed(
  platformType: string,
  platformConversationId: string,
  options?: { merged?: boolean }
): Promise<void> {
  getLog().info({ platformType, platformConversationId }, 'conversation_closed');

  // Find the conversation
  const conversation = await conversationDb.getConversationByPlatformId(
    platformType,
    platformConversationId
  );

  if (!conversation?.isolation_env_id) {
    getLog().debug({ platformType, platformConversationId }, 'no_isolation_env_to_cleanup');
    return;
  }

  const envId = conversation.isolation_env_id;

  // Deactivate any active sessions first
  const session = await sessionDb.getActiveSession(conversation.id);
  if (session) {
    try {
      await sessionDb.deactivateSession(session.id, 'conversation-closed');
      getLog().info(
        { sessionId: session.id, trigger: 'conversation-closed' },
        'session_deactivated'
      );
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        getLog().debug({ sessionId: session.id }, 'session_already_deactivated');
      } else {
        throw error;
      }
    }
  }

  // Get the environment
  const env = await isolationEnvDb.getById(envId);
  if (!env) {
    getLog().debug({ envId }, 'env_not_found_in_db');
    return;
  }

  const reason = unknownPlatformReason(env.created_by_platform);
  if (reason) {
    getLog().warn({ envId, reason }, 'cleanup_skipped');
    return;
  }

  // Live work is the only lock — the same rule the merged cleanup sweep follows.
  // Historical conversations referencing this env are data, not locks. This must
  // read before the null-out below: a top-level run attaches to its env ONLY
  // through this conversation's reference, so clearing first would erase the
  // pin and let the env be removed under a running or paused run.
  const liveRun = await getLiveRunBlocker(envId);
  if (liveRun) {
    getLog().info(
      { envId, runId: liveRun.runId, runStatus: liveRun.runStatus },
      'env_has_live_run'
    );
    return;
  }

  const result = await removeEnvironment(env, {
    force: false,
    deleteRemoteBranch: options?.merged,
  });
  if (result.skippedReason && result.skippedReason !== 'already destroyed') {
    throw new Error(`Conversation cleanup retained environment ${envId}: ${result.skippedReason}`);
  }

  // Clear this conversation's reference (best-effort - conversation may be deleted).
  // `cwd` is cleared alongside it when it names the removed environment:
  // a chat turn uses `cwd` verbatim and refuses a missing directory.
  // Null means "no override": the conversation falls back to codebase.default_cwd,
  // the same end state
  // /setproject produces. A cwd pointing somewhere else is left untouched.
  const cwdBelongsToEnv = conversation.cwd === env.working_path;
  await conversationDb
    .updateConversation(conversation.id, {
      isolation_env_id: null,
      ...(cwdBelongsToEnv ? { cwd: null } : {}),
    })
    .catch(err => {
      if (!(err instanceof ConversationNotFoundError)) throw err;
    });
}

/**
 * Run full scheduled cleanup cycle
 * 1. Find and remove merged branches
 * 2. Find and remove stale environments
 */
export async function runScheduledCleanup(): Promise<CleanupReport> {
  // Fail before any sweep can mutate rows, even when there are no environments.
  getRegisteredPlatformPolicies();
  getLog().info('cleanup_started');
  const report: CleanupReport = {
    removed: [],
    skipped: [],
    errors: [],
    sessionsDeleted: 0,
    releasedFailedRuns: [],
  };

  try {
    const environments = await isolationEnvDb.listAllActiveWithCodebase();
    getLog().info({ count: environments.length }, 'active_environments_found');
    const sweep = {
      staleDays: STALE_THRESHOLD_DAYS,
      prStateCache: new Map<string, PrLookup>(),
      report,
    };
    for (const env of environments) {
      try {
        await sweepScheduledEnvironment(env, sweep);
      } catch (error) {
        const err = error as Error;
        report.errors.push({ id: env.id, error: err.message });
        getLog().error({ err: error, envId: env.id }, 'env_cleanup_error');
        // Continue to next environment - don't crash the cleanup cycle
      }
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err: error }, 'scheduled_cleanup_failed');
    report.errors.push({ id: 'scheduler', error: err.message });
  }

  // Clean up old inactive sessions
  try {
    report.sessionsDeleted = await sessionDb.deleteOldSessions(SESSION_RETENTION_DAYS);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err: error }, 'session_cleanup_failed');
    report.errors.push({ id: 'session-cleanup', error: err.message });
  }

  getLog().info(
    {
      removed: report.removed.length,
      skipped: report.skipped.length,
      errors: report.errors.length,
      sessionsDeleted: report.sessionsDeleted,
    },
    'cleanup_completed'
  );

  return report;
}

/**
 * Get detailed worktree status breakdown for a codebase
 * Includes git operations to detect merged branches
 */
export async function getWorktreeStatusBreakdown(
  codebaseId: string,
  mainRepoPath: string
): Promise<WorktreeStatusBreakdown> {
  getRegisteredPlatformPolicies();
  const environments = (await isolationEnvDb.listByCodebaseWithAge(codebaseId)).filter(
    env => env.provider === 'worktree'
  );

  const repoPath = toRepoPath(mainRepoPath);
  const breakdown: WorktreeStatusBreakdown = {
    total: environments.length,
    merged: 0,
    stale: 0,
    active: 0,
    mergedEnvs: [],
    staleEnvs: [],
    activeEnvs: [],
  };

  const { remoteMainRef } = await resolveRepoGitContext(repoPath, mainRepoPath);

  for (const env of environments) {
    const reason = unknownPlatformReason(env.created_by_platform);
    if (reason) {
      breakdown.active++;
      breakdown.activeEnvs.push({ id: env.id, branchName: env.branch_name, reason });
      continue;
    }
    const retained = retainsWorkspace(env.created_by_platform);

    // Check if merged (treat as not-merged on unexpected errors)
    let merged = false;
    try {
      merged = await isBranchMerged(repoPath, toBranchName(env.branch_name), remoteMainRef);
    } catch (error) {
      getLog().warn(
        { err: error, envId: env.id, branchName: env.branch_name },
        'merge_check_error_in_breakdown'
      );
    }
    // Fallback to patch-equivalence for squash-merge detection.
    if (!merged) {
      try {
        merged = await isPatchEquivalent(repoPath, toBranchName(env.branch_name), remoteMainRef);
      } catch {
        // Patch-equivalence is best-effort; a failure doesn't change the result.
      }
    }
    if (merged) {
      breakdown.merged++;
      breakdown.mergedEnvs.push({ id: env.id, branchName: env.branch_name });
      continue;
    }

    const isStale = !retained && env.days_since_activity >= STALE_THRESHOLD_DAYS;
    if (isStale) {
      breakdown.stale++;
      breakdown.staleEnvs.push({
        id: env.id,
        branchName: env.branch_name,
        daysInactive: env.days_since_activity,
      });
      continue;
    }

    // Active
    breakdown.active++;
    breakdown.activeEnvs.push({ id: env.id, branchName: env.branch_name });
  }

  return breakdown;
}

/**
 * Clean up stale worktrees for a codebase
 * Respects uncommitted changes and live workflow runs
 */
export async function cleanupStaleWorktrees(
  codebaseId: string,
  mainRepoPath: string
): Promise<CleanupOperationResult> {
  const result: CleanupOperationResult = {
    errors: [],
    removed: [],
    skipped: [],
    warnings: [],
    releasedFailedRuns: [],
  };
  const repoPath = toRepoPath(mainRepoPath);
  getRegisteredPlatformPolicies();
  const environments = (await isolationEnvDb.listByCodebaseWithAge(codebaseId)).filter(
    env => env.provider === 'worktree'
  );

  for (const env of environments) {
    const reason = unknownPlatformReason(env.created_by_platform);
    if (reason) {
      result.skipped.push({ branchName: env.branch_name, reason });
      continue;
    }
    if (retainsWorkspace(env.created_by_platform)) continue;

    // Check if stale
    if (env.days_since_activity < STALE_THRESHOLD_DAYS) continue;

    try {
      const check = await checkRemoval(env, repoPath, {
        kind: 'stale',
        staleDays: STALE_THRESHOLD_DAYS,
      });
      if (check.blocker) {
        result.skipped.push({ branchName: env.branch_name, reason: check.blocker.display });
        continue;
      }
      const removeResult = await removeEnvironment(env);
      recordCleanupRemoval(result, env.branch_name, removeResult, check.released);
    } catch (error) {
      const err = error as Error;
      result.errors.push({ branchName: env.branch_name, error: err.message });
    }
  }

  return result;
}

/**
 * Start the cleanup scheduler
 * Runs cleanup cycle every CLEANUP_INTERVAL_HOURS
 */
export function startCleanupScheduler(): void {
  // Fail at host startup rather than in a timer callback hours later.
  getRegisteredPlatformPolicies();
  if (cleanupIntervalId) {
    getLog().warn('scheduler_already_running');
    return;
  }

  const intervalMs = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;
  getLog().info({ intervalHours: CLEANUP_INTERVAL_HOURS }, 'scheduler_starting');

  // Run immediately on startup, then at interval
  void runScheduledCleanup().catch(err => {
    getLog().error({ err }, 'initial_cleanup_failed');
  });

  cleanupIntervalId = setInterval(() => {
    void runScheduledCleanup().catch(err => {
      getLog().error({ err }, 'scheduled_cleanup_failed');
    });
  }, intervalMs);

  getLog().info('scheduler_started');
}

/**
 * Stop the cleanup scheduler
 */
export function stopCleanupScheduler(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    getLog().info('scheduler_stopped');
  }
}
