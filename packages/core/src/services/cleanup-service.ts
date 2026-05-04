/**
 * Cleanup service for isolation environments
 * Handles removal triggered by events, schedule, or commands
 */
import * as isolationEnvDb from '../db/isolation-environments';
import * as conversationDb from '../db/conversations';
import * as sessionDb from '../db/sessions';
import { SessionNotFoundError } from '../db/sessions';
import * as codebaseDb from '../db/codebases';
import { getIsolationProvider, getPrState } from '@archon/isolation';
import type { WorktreeStatusBreakdown, PrState } from '@archon/isolation';
import {
  hasUncommittedChanges,
  worktreeExists,
  getDefaultBranch,
  isBranchMerged,
  isPatchEquivalent,
  getLastCommitDate,
  toRepoPath,
  toWorktreePath,
  toBranchName,
} from '@archon/git';
import type { RepoPath, BranchName } from '@archon/git';
import { createLogger } from '@archon/paths';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import { ConversationNotFoundError } from '../types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cleanup');
  return cachedLog;
}

// Configuration constants (configurable via env vars)
const STALE_THRESHOLD_DAYS = parseInt(process.env.STALE_THRESHOLD_DAYS ?? '14', 10);
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS ?? '6', 10);
const SESSION_RETENTION_DAYS = parseInt(process.env.SESSION_RETENTION_DAYS ?? '30', 10);

// Export configuration for use by other modules
export { STALE_THRESHOLD_DAYS, SESSION_RETENTION_DAYS };

// Module-level variable for scheduler
let cleanupIntervalId: NodeJS.Timeout | null = null;

export interface CleanupReport {
  removed: string[];
  skipped: { id: string; reason: string }[];
  errors: { id: string; error: string }[];
  sessionsDeleted: number;
}

/**
 * Called when a platform conversation is closed (e.g., GitHub issue/PR closed)
 * Cleans up the associated isolation environment if no other conversations use it
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

  // Clear this conversation's reference (best-effort - conversation may be deleted)
  await conversationDb
    .updateConversation(conversation.id, { isolation_env_id: null })
    .catch(err => {
      if (!(err instanceof ConversationNotFoundError)) throw err;
    });

  // Check if other conversations still use this environment
  const otherConversations = await isolationEnvDb.getConversationsUsingEnv(envId);
  if (otherConversations.length > 0) {
    getLog().info({ envId, conversationCount: otherConversations.length }, 'env_still_in_use');
    return;
  }

  // No other users - attempt removal
  await removeEnvironment(envId, {
    force: false,
    deleteRemoteBranch: options?.merged,
  });
}

/**
 * Options for removing an isolation environment
 */
export interface RemoveEnvironmentOptions {
  force?: boolean;
  deleteRemoteBranch?: boolean;
}

/**
 * Result from removeEnvironment indicating what actually happened
 */
export interface RemoveEnvironmentResult {
  /** Whether the worktree was removed from disk */
  worktreeRemoved: boolean;
  /** Whether the branch was deleted (null if branch cleanup was not attempted) */
  branchDeleted: boolean | null;
  /** If the operation was a no-op, why it was skipped */
  skippedReason?: string;
  /** Warnings from partial cleanup (e.g., branch couldn't be deleted) */
  warnings: string[];
}

/**
 * Remove a specific environment
 */
export async function removeEnvironment(
  envId: string,
  options?: RemoveEnvironmentOptions
): Promise<RemoveEnvironmentResult> {
  const noopResult: RemoveEnvironmentResult = {
    worktreeRemoved: false,
    branchDeleted: false,
    warnings: [],
  };

  const env = await isolationEnvDb.getById(envId);
  if (!env) {
    getLog().debug({ envId }, 'env_not_found');
    return { ...noopResult, skippedReason: 'environment not found' };
  }

  if (env.status === 'destroyed') {
    getLog().debug({ envId }, 'env_already_destroyed');
    return { ...noopResult, skippedReason: 'already destroyed' };
  }

  // Get canonical repo path from codebase for branch cleanup
  let canonicalRepoPath: RepoPath | undefined;
  if (env.codebase_id) {
    const codebase = await codebaseDb.getCodebase(env.codebase_id);
    canonicalRepoPath = codebase?.default_cwd ? toRepoPath(codebase.default_cwd) : undefined;
  }

  // Check if directory exists before attempting removal
  const pathExists = await worktreeExists(toWorktreePath(env.working_path));

  const provider = getIsolationProvider();

  try {
    // If path exists, check for uncommitted changes (unless force)
    if (pathExists && !options?.force) {
      const hasChanges = await hasUncommittedChanges(toWorktreePath(env.working_path));
      if (hasChanges) {
        getLog().warn({ envId, workingPath: env.working_path }, 'env_has_uncommitted_changes');
        return { ...noopResult, skippedReason: 'has uncommitted changes' };
      }
    }

    // Remove the worktree (and branch if provided)
    // Call destroy even if path doesn't exist - branch cleanup may still be needed
    const destroyResult = await provider.destroy(env.working_path, {
      force: options?.force,
      branchName: toBranchName(env.branch_name),
      canonicalRepoPath,
      deleteRemoteBranch: options?.deleteRemoteBranch,
    });

    // Log warnings from partial failures
    if (destroyResult.warnings.length > 0) {
      getLog().warn({ envId, warnings: destroyResult.warnings }, 'env_partial_cleanup');
    }

    // Mark as destroyed in database
    await isolationEnvDb.updateStatus(envId, 'destroyed');

    getLog().info({ envId, workingPath: env.working_path }, 'env_removed');

    return {
      worktreeRemoved: destroyResult.worktreeRemoved,
      branchDeleted: destroyResult.branchDeleted,
      warnings: destroyResult.warnings,
    };
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Handle "directory not found" errors gracefully
    // Be specific: check that the error is about the worktree path, not unrelated paths
    const isPathNotFoundError =
      err.code === 'ENOENT' ||
      (errorText.includes(env.working_path) &&
        (errorText.includes('No such file or directory') ||
          errorText.includes('does not exist') ||
          errorText.includes('is not a working tree')));

    if (isPathNotFoundError) {
      await isolationEnvDb.updateStatus(envId, 'destroyed');
      getLog().info({ envId }, 'env_removed_externally');
      return { worktreeRemoved: true, branchDeleted: false, warnings: [] };
    }

    getLog().error({ err, envId }, 'env_remove_failed');
    throw err;
  }
}

/**
 * Clean up to make room when limit reached (Phase 3D)
 * Attempts to remove merged branches first
 * Returns detailed results for user feedback
 */
export async function cleanupToMakeRoom(
  codebaseId: string,
  mainRepoPath: string
): Promise<CleanupOperationResult> {
  // Reuse the merged cleanup logic
  return cleanupMergedWorktrees(codebaseId, mainRepoPath);
}

/**
 * Returns the reason the environment cannot be removed, or null if it is safe to remove.
 * Checks uncommitted changes first (avoids a DB query when changes are present),
 * then active conversation references.
 */
type RemovalBlocker =
  | { reason: 'uncommitted_changes'; display: string }
  | { reason: 'in_use'; display: string; conversationCount: number };

async function getRemovalBlocker(env: {
  id: string;
  working_path: string;
}): Promise<RemovalBlocker | null> {
  const hasChanges = await hasUncommittedChanges(toWorktreePath(env.working_path));
  if (hasChanges) return { reason: 'uncommitted_changes', display: 'has uncommitted changes' };
  const conversations = await isolationEnvDb.getConversationsUsingEnv(env.id);
  if (conversations.length > 0)
    return {
      reason: 'in_use',
      display: `still used by ${String(conversations.length)} conversation(s)`,
      conversationCount: conversations.length,
    };
  return null;
}

/**
 * Run full scheduled cleanup cycle
 * 1. Find and remove merged branches
 * 2. Find and remove stale environments
 */
export async function runScheduledCleanup(): Promise<CleanupReport> {
  getLog().info('cleanup_started');
  const report: CleanupReport = { removed: [], skipped: [], errors: [], sessionsDeleted: 0 };

  try {
    // Get all active environments with their codebase info
    const environments = await isolationEnvDb.listAllActiveWithCodebase();
    getLog().info({ count: environments.length }, 'active_environments_found');

    for (const env of environments) {
      try {
        // Skip if already processing or destroyed
        if (env.status !== 'active') continue;

        // Check if path still exists
        const pathExists = await worktreeExists(toWorktreePath(env.working_path));
        if (!pathExists) {
          // Path doesn't exist - call removeEnvironment to clean up branch and mark as destroyed
          const removeResult = await removeEnvironment(env.id, { force: false });
          if (removeResult.skippedReason) {
            report.skipped.push({ id: env.id, reason: removeResult.skippedReason });
          } else {
            report.removed.push(`${env.id} (path missing)`);
          }
          continue;
        }

        // Check if branch is merged
        const mainRepoPath = toRepoPath(env.codebase_default_cwd);
        const mainBranch = await getDefaultBranch(mainRepoPath);
        const merged = await isBranchMerged(
          mainRepoPath,
          toBranchName(env.branch_name),
          mainBranch
        );

        if (merged) {
          const blocker = await getRemovalBlocker(env);
          if (blocker) {
            report.skipped.push({ id: env.id, reason: `merged but ${blocker.display}` });
            if (blocker.reason === 'in_use') {
              getLog().info(
                { envId: env.id, conversationCount: blocker.conversationCount },
                'skip_merged_still_in_use'
              );
            } else {
              getLog().warn({ envId: env.id }, 'skip_merged_uncommitted_changes');
            }
            continue;
          }

          // Safe to remove merged branch (also delete remote branch)
          const mergedResult = await removeEnvironment(env.id, {
            force: false,
            deleteRemoteBranch: true,
          });
          if (mergedResult.skippedReason) {
            report.skipped.push({ id: env.id, reason: mergedResult.skippedReason });
          } else {
            report.removed.push(`${env.id} (merged)`);
          }
          continue;
        }

        // Check staleness (skip Telegram - already filtered in query but double-check)
        if (env.created_by_platform === 'telegram') {
          continue; // Never cleanup Telegram (persistent workspace)
        }

        // Check if environment is stale
        const isStale = await isEnvironmentStale(env, STALE_THRESHOLD_DAYS);
        if (isStale) {
          const blocker = await getRemovalBlocker(env);
          if (blocker) {
            report.skipped.push({ id: env.id, reason: `stale but ${blocker.display}` });
            if (blocker.reason === 'in_use') {
              getLog().info(
                { envId: env.id, conversationCount: blocker.conversationCount },
                'skip_stale_still_in_use'
              );
            } else {
              getLog().warn({ envId: env.id }, 'skip_stale_uncommitted_changes');
            }
            continue;
          }

          const staleResult = await removeEnvironment(env.id, { force: false });
          if (staleResult.skippedReason) {
            report.skipped.push({ id: env.id, reason: staleResult.skippedReason });
          } else {
            report.removed.push(`${env.id} (stale)`);
          }
        }
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
 * Check if an environment is stale based on activity
 */
async function isEnvironmentStale(
  env: IsolationEnvironmentRow,
  staleDays: number
): Promise<boolean> {
  // Check last commit date in the worktree
  const lastCommit = await getLastCommitDate(toWorktreePath(env.working_path));
  if (lastCommit) {
    const daysSinceCommit = (Date.now() - lastCommit.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCommit < staleDays) {
      return false; // Recent commit activity
    }
  }

  // Check environment creation date as fallback
  const daysSinceCreation =
    (Date.now() - new Date(env.created_at).getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceCreation >= staleDays;
}

// =============================================================================
// Phase 3D: Worktree Limits and User Feedback
// =============================================================================

/**
 * Result from cleanup operations with detailed information
 */
export interface CleanupOperationResult {
  removed: string[];
  skipped: { branchName: string; reason: string }[];
}

/**
 * Get detailed worktree status breakdown for a codebase
 * Includes git operations to detect merged branches
 */
export async function getWorktreeStatusBreakdown(
  codebaseId: string,
  mainRepoPath: string,
  remote?: string
): Promise<WorktreeStatusBreakdown> {
  const environments = await isolationEnvDb.listByCodebaseWithAge(codebaseId);

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

  const mainBranch = await getDefaultBranch(repoPath, remote);

  for (const env of environments) {
    // Skip Telegram (never shown as stale)
    const isTelegram = env.created_by_platform === 'telegram';

    // Check if merged (treat as not-merged on unexpected errors)
    let merged = false;
    try {
      merged = await isBranchMerged(repoPath, toBranchName(env.branch_name), mainBranch);
    } catch (error) {
      getLog().warn(
        { err: error, envId: env.id, branchName: env.branch_name },
        'merge_check_error_in_breakdown'
      );
    }
    if (merged) {
      breakdown.merged++;
      breakdown.mergedEnvs.push({ id: env.id, branchName: env.branch_name });
      continue;
    }

    // Check if stale (non-Telegram only)
    const isStale = !isTelegram && env.days_since_activity >= STALE_THRESHOLD_DAYS;
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
 * Respects uncommitted changes and conversation references
 */
export async function cleanupStaleWorktrees(
  codebaseId: string,
  _mainRepoPath: string
): Promise<CleanupOperationResult> {
  const result: CleanupOperationResult = { removed: [], skipped: [] };
  const environments = await isolationEnvDb.listByCodebaseWithAge(codebaseId);

  for (const env of environments) {
    // Skip Telegram
    if (env.created_by_platform === 'telegram') continue;

    // Check if stale
    if (env.days_since_activity < STALE_THRESHOLD_DAYS) continue;

    // Check for uncommitted changes or active conversation references
    const blocker = await getRemovalBlocker(env);
    if (blocker) {
      result.skipped.push({ branchName: env.branch_name, reason: blocker.display });
      continue;
    }

    // Safe to remove
    try {
      const removeResult = await removeEnvironment(env.id);
      if (removeResult.skippedReason) {
        result.skipped.push({ branchName: env.branch_name, reason: removeResult.skippedReason });
      } else {
        result.removed.push(env.branch_name);
      }
    } catch (error) {
      const err = error as Error;
      result.skipped.push({ branchName: env.branch_name, reason: err.message });
    }
  }

  return result;
}

/**
 * Decide whether a branch is safe to remove using a union of signals:
 *   (a) git ancestry  — `git branch --merged` (catches fast-forward / merge-commit)
 *   (b) git cherry    — patch-equivalent commits (catches squash-merge)
 *   (c) GitHub PR state via `gh` CLI — MERGED/CLOSED/OPEN
 *
 * Returns `{ safe, openPr }`. `openPr=true` only when the PR state is OPEN —
 * callers use this to surface a clearer skip reason.
 */
async function isSafeToRemove(
  repoPath: RepoPath,
  branchName: BranchName,
  mainBranch: BranchName,
  prStateCache: Map<string, PrState>,
  includeClosed: boolean,
  remote?: string
): Promise<{ safe: boolean; openPr: boolean }> {
  // (a) Fast path — fast-forward / merge-commit ancestry
  if (await isBranchMerged(repoPath, branchName, mainBranch)) {
    return { safe: true, openPr: false };
  }
  // (b) Squash-merge detection via patch equivalence
  if (await isPatchEquivalent(repoPath, branchName, mainBranch)) {
    return { safe: true, openPr: false };
  }
  // (c) GitHub PR state
  const prState = await getPrState(branchName, repoPath, prStateCache, remote);
  if (prState === 'MERGED') return { safe: true, openPr: false };
  if (prState === 'CLOSED') return { safe: includeClosed, openPr: false };
  if (prState === 'OPEN') return { safe: false, openPr: true };
  return { safe: false, openPr: false };
}

/**
 * Clean up merged worktrees for a codebase
 * Respects uncommitted changes and conversation references
 */
export async function cleanupMergedWorktrees(
  codebaseId: string,
  mainRepoPath: string,
  options: { includeClosed?: boolean; remote?: string } = {}
): Promise<CleanupOperationResult> {
  const result: CleanupOperationResult = { removed: [], skipped: [] };
  const environments = await isolationEnvDb.listByCodebase(codebaseId);
  const repoPath = toRepoPath(mainRepoPath);
  const mainBranch = await getDefaultBranch(repoPath, options.remote);
  const includeClosed = options.includeClosed ?? false;
  const prStateCache = new Map<string, PrState>();

  for (const env of environments) {
    let safe = false;
    let openPr = false;
    try {
      const branchName = toBranchName(env.branch_name);
      const decision = await isSafeToRemove(
        repoPath,
        branchName,
        mainBranch,
        prStateCache,
        includeClosed,
        options.remote
      );
      safe = decision.safe;
      openPr = decision.openPr;
    } catch (error) {
      const err = error as Error;
      result.skipped.push({
        branchName: env.branch_name,
        reason: `merge check failed: ${err.message}`,
      });
      continue;
    }
    if (!safe) {
      if (openPr) {
        result.skipped.push({
          branchName: env.branch_name,
          reason: 'PR is open (active review)',
        });
      }
      continue;
    }

    // Check for uncommitted changes or active conversation references
    const blocker = await getRemovalBlocker(env);
    if (blocker) {
      result.skipped.push({ branchName: env.branch_name, reason: blocker.display });
      continue;
    }

    // Safe to remove (also delete remote branch since it's merged)
    try {
      const removeResult = await removeEnvironment(env.id, { deleteRemoteBranch: true });
      if (removeResult.skippedReason) {
        result.skipped.push({ branchName: env.branch_name, reason: removeResult.skippedReason });
      } else {
        result.removed.push(env.branch_name);
      }
    } catch (error) {
      const err = error as Error;
      result.skipped.push({ branchName: env.branch_name, reason: err.message });
    }
  }

  return result;
}

/**
 * Start the cleanup scheduler
 * Runs cleanup cycle every CLEANUP_INTERVAL_HOURS
 */
export function startCleanupScheduler(): void {
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

/**
 * Check if scheduler is running (for testing)
 */
export function isSchedulerRunning(): boolean {
  return cleanupIntervalId !== null;
}
