/**
 * Cleanup service for isolation environments
 * Handles removal triggered by events, schedule, or commands
 */
import { lstat } from 'node:fs/promises';
import { readOwnedWorktree, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  readWorktreeCreationId,
  WorktreeLeftoverError,
  type IIsolationStore,
} from '@archon/isolation';
import {
  getRegisteredPlatformPolicies,
  unknownPlatformReason,
  retainsWorkspace,
  type UnknownPlatformReason,
} from '../platforms/registry';
import * as isolationEnvDb from '../db/isolation-environments';
import * as conversationDb from '../db/conversations';
import * as sessionDb from '../db/sessions';
import { SessionNotFoundError } from '../db/sessions';
import * as codebaseDb from '../db/codebases';
import * as workflowDb from '../db/workflows';
import { getIsolationProvider, getPrState, ContainerBackend } from '@archon/isolation';
import type { WorktreeStatusBreakdown, PrLookup, ContainerBackendConfig } from '@archon/isolation';
import {
  hasUncommittedChanges,
  isWorktreeRegistered,
  worktreeExists,
  getDefaultBranch,
  isBranchMerged,
  isPatchEquivalent,
  localBranchExists,
  isRevCoveredBy,
  getLastCommitDate,
  toRepoPath,
  toWorktreePath,
  toBranchName,
} from '@archon/git';
import type { RepoPath, BranchName, WorktreePath } from '@archon/git';
import { createLogger } from '@archon/paths';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import { ConversationNotFoundError } from '../types';
import { loadRepoConfig } from '../config/config-loader';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cleanup');
  return cachedLog;
}

/** Git context for a repo's cleanup operations, resolved from repo config. */
interface RepoGitContext {
  /** Remote-qualified base ref (e.g. "origin/main"), kept current via `git fetch`. */
  remoteMainRef: BranchName;
  /** Configured remote name (worktree.remote). Always resolved to a string (defaults to 'origin'). */
  remote: string;
}

// Resolve the base branch and remote for a repo, preferring worktree.baseBranch /
// worktree.remote from .archon/config.yaml before falling back to runtime git
// detection. A reachable remote with a known symbolic HEAD is required unless
// worktree.baseBranch is configured.
// loadRepoConfig returns {} for a missing or unreadable config, so those degrade
// to git detection; it throws only when `assistants.*` names a setting the
// provider cannot honour, which cleanup surfaces rather than working around.
async function resolveRepoGitContext(repoPath: RepoPath, cwd: string): Promise<RepoGitContext> {
  const repoConfig = await loadRepoConfig(cwd);
  const remote = repoConfig.worktree?.remote?.trim() || 'origin';
  const configured = repoConfig.worktree?.baseBranch?.trim();
  if (configured) {
    return { remoteMainRef: toBranchName(`${remote}/${configured}`), remote };
  }
  const branch = await getDefaultBranch(repoPath, remote);
  return { remoteMainRef: toBranchName(`${remote}/${branch}`), remote };
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

// ---------------------------------------------------------------------------
// Container isolation environments (folder-project container backend, Phase C)
// ---------------------------------------------------------------------------

/**
 * `ContainerBackend.destroy()` reads the container/volume names from the tracking
 * row's metadata and IGNORES `config` (config is a prepare-time concern), so a
 * placeholder is correct for the cleanup path — it never prepares a container.
 */
const CLEANUP_PLACEHOLDER_CONTAINER_CONFIG: ContainerBackendConfig = {
  image: 'archon-runner:latest',
  network: 'bridge',
  memoryMb: 4096,
  pidsLimit: 512,
};

export interface ContainerEnvSummary {
  envId: string;
  codebaseName: string;
  workingPath: string;
  ageDays: number;
  runId: string | null;
  runStatus: string | null;
}

export interface ContainerCleanupReport {
  removed: string[];
  skipped: { id: string; reason: string }[];
  errors: { id: string; error: string }[];
}

/**
 * Immediately reclaim (destroy) a single container isolation environment by id —
 * used when a container run is ABANDONED (M2), so its container + upper volume don't
 * linger until the scheduled reaper. Best-effort: throws on a genuine docker failure
 * (the caller surfaces it), a no-op if the row/container is already gone. The
 * placeholder config is unused by `destroy` (see CLEANUP_PLACEHOLDER_CONTAINER_CONFIG).
 */
export async function reclaimContainerEnv(envId: string, store: IIsolationStore): Promise<void> {
  const env = await store.getById(envId);
  if (env) {
    const reason = unknownPlatformReason(env.created_by_platform);
    if (reason) throw new Error(reason);
  }
  const backend = new ContainerBackend({
    store,
    config: CLEANUP_PLACEHOLDER_CONTAINER_CONFIG,
  });
  await backend.destroy(envId);
}

/**
 * List active container isolation environments with their owning run's status.
 * Read-only; used by `archon isolation list`.
 */
export async function listContainerEnvironments(): Promise<readonly ContainerEnvSummary[]> {
  const rows = await isolationEnvDb.listActiveContainerEnvironments();
  const summaries: ContainerEnvSummary[] = [];
  for (const row of rows) {
    // A lookup ERROR is reported as an explicit 'lookup-failed' status, NOT null — a
    // null runId reads as "orphan" and would misrepresent an active run's container.
    let run: Awaited<ReturnType<typeof workflowDb.getRunByIsolationEnvId>> | null = null;
    let lookupFailed = false;
    try {
      run = await workflowDb.getRunByIsolationEnvId(row.id);
    } catch (err) {
      lookupFailed = true;
      getLog().warn({ err, envId: row.id }, 'container_env_list_lookup_failed');
    }
    summaries.push({
      envId: row.id,
      codebaseName: row.codebase_name,
      workingPath: row.working_path,
      ageDays: Math.floor(row.days_since_created),
      runId: run?.id ?? null,
      runStatus: lookupFailed ? 'lookup-failed' : (run?.status ?? null),
    });
  }
  return summaries;
}

/**
 * Reap orphaned container isolation environments: remove the container + upper
 * volume of finished-and-unresumable (completed/cancelled) or run-less container
 * envs older than `daysStale`. A container a run can still claim — running, pending,
 * paused, or failed-but-resumable — is NEVER touched: it is awaited state, not
 * garbage (No-Autonomous-Lifecycle-Mutation Across Process Boundaries), and is
 * surfaced by `isolation list` with its age instead. All pruning is label-scoped
 * (via the tracking row), never a bare `docker prune`.
 */
export async function cleanupContainerEnvironments(
  daysStale = STALE_THRESHOLD_DAYS
): Promise<ContainerCleanupReport> {
  getRegisteredPlatformPolicies();
  const report: ContainerCleanupReport = { removed: [], skipped: [], errors: [] };
  const rows = await isolationEnvDb.listActiveContainerEnvironments();
  if (rows.length === 0) return report;

  const backend = new ContainerBackend({
    store: isolationEnvDb.createIsolationStore(),
    config: CLEANUP_PLACEHOLDER_CONTAINER_CONFIG,
  });

  for (const row of rows) {
    const reason = unknownPlatformReason(row.created_by_platform);
    if (reason) {
      report.skipped.push({ id: row.id, reason });
      continue;
    }
    if (retainsWorkspace(row.created_by_platform)) {
      report.skipped.push({
        id: row.id,
        reason: `platform '${row.created_by_platform}' retains workspaces`,
      });
      continue;
    }
    // FAIL CLOSED on an ambiguous lookup (H3): a DB error is NOT "no run" — treating
    // it as an orphan would destroy a claimable run's container on a transient blip
    // (violating No-Autonomous-Lifecycle-Mutation). Report + skip, never destroy.
    //
    // Same lock the worktree sweeps use. getRunByIsolationEnvId, which this replaced,
    // took the newest run row BEFORE filtering status, so a newer terminal run could
    // shadow an older claimable one and the container would be reaped underneath it.
    let liveRun: Awaited<ReturnType<typeof isolationEnvDb.getLiveRunOwningEnv>>;
    try {
      liveRun = await isolationEnvDb.getLiveRunOwningEnv(row.id);
    } catch (err) {
      report.errors.push({
        id: row.id,
        error: `run lookup failed (NOT reaped): ${(err as Error).message}`,
      });
      getLog().warn({ err, envId: row.id }, 'container_env_reap_lookup_failed');
      continue;
    }
    if (liveRun) {
      report.skipped.push({
        id: row.id,
        reason: `run ${liveRun.id.slice(0, 8)} is ${liveRun.status}`,
      });
      continue;
    }
    if (row.days_since_created < daysStale) {
      report.skipped.push({
        id: row.id,
        reason: `${Math.floor(row.days_since_created)}d old (< ${daysStale}d threshold)`,
      });
      continue;
    }
    try {
      await backend.destroy(row.id);
      report.removed.push(row.id);
      // No runId: the reap only happens when no run can still claim this env.
      getLog().info({ envId: row.id }, 'container_env_reaped');
    } catch (err) {
      report.errors.push({ id: row.id, error: (err as Error).message });
      getLog().warn({ err, envId: row.id }, 'container_env_reap_failed');
    }
  }
  return report;
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
  const liveRun = await isolationEnvDb.getLiveRunOwningEnv(envId);
  if (liveRun) {
    getLog().info({ envId, runId: liveRun.id, runStatus: liveRun.status }, 'env_has_live_run');
    return;
  }

  const result = await removeEnvironment(envId, {
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
  /**
   * Why removal did not proceed. A closed set so callers that branch
   * on a reason fail type-check when it changes, instead of silently diverging.
   */
  skippedReason?:
    | 'environment not found'
    | 'already destroyed'
    | 'has uncommitted changes'
    | 'filesystem removal incomplete; environment remains active'
    | UnknownPlatformReason;
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

  const reason = unknownPlatformReason(env.created_by_platform);
  if (reason) return { ...noopResult, skippedReason: reason };

  // Get canonical repo path from codebase for branch cleanup
  let canonicalRepoPath: RepoPath | undefined;
  let configuredRemote: string | undefined;
  if (env.codebase_id) {
    const codebase = await codebaseDb.getCodebase(env.codebase_id);
    canonicalRepoPath = codebase?.default_cwd ? toRepoPath(codebase.default_cwd) : undefined;
    // Resolve the configured remote only when remote-branch deletion is requested —
    // that's the one destroy path that pushes to a remote.
    if (options?.deleteRemoteBranch && codebase?.default_cwd) {
      const repoConfig = await loadRepoConfig(codebase.default_cwd);
      configuredRemote = repoConfig.worktree?.remote?.trim() || 'origin';
    }
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
      creationId: readWorktreeCreationId(env.metadata) ?? undefined,
      branchName: toBranchName(env.branch_name),
      canonicalRepoPath,
      deleteRemoteBranch: options?.deleteRemoteBranch,
      remote: configuredRemote,
    });

    // Log warnings from partial failures
    if (destroyResult.warnings.length > 0) {
      getLog().warn({ envId, warnings: destroyResult.warnings }, 'env_partial_cleanup');
    }

    if (!destroyResult.worktreeRemoved || !destroyResult.directoryClean) {
      return {
        worktreeRemoved: destroyResult.worktreeRemoved,
        branchDeleted: destroyResult.branchDeleted,
        warnings: destroyResult.warnings,
        skippedReason: 'filesystem removal incomplete; environment remains active',
      };
    }
    await isolationEnvDb.updateStatus(envId, 'destroyed');

    getLog().info({ envId, workingPath: env.working_path }, 'env_removed');

    return {
      worktreeRemoved: destroyResult.worktreeRemoved,
      branchDeleted: destroyResult.branchDeleted,
      warnings: destroyResult.warnings,
    };
  } catch (error) {
    const err = error as Error;
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
 * then live work: a workflow run that can still claim the environment.
 */
type RemovalBlocker =
  | { reason: 'uncommitted_changes'; display: string }
  | { reason: 'live_run'; display: string; runId: string; runStatus: string };

async function getRemovalBlocker(env: {
  id: string;
  working_path: string;
}): Promise<RemovalBlocker | null> {
  const hasChanges = await hasUncommittedChanges(toWorktreePath(env.working_path));
  if (hasChanges) return { reason: 'uncommitted_changes', display: 'has uncommitted changes' };
  // Live work is the only lock: a run that can still claim the env blocks removal —
  // running, pending, paused, or failed-but-resumable. Historical conversation
  // references are data, not locks (same rule the merged cleanup sweep follows) —
  // see getLiveRunOwningEnv.
  const liveRun = await isolationEnvDb.getLiveRunOwningEnv(env.id);
  if (liveRun) {
    return {
      reason: 'live_run',
      display: `run ${liveRun.id.slice(0, 8)} is ${liveRun.status}`,
      runId: liveRun.id,
      runStatus: liveRun.status,
    };
  }
  return null;
}

/**
 * How a branch's merge state came out, from the union of signals both cleanup
 * sweeps share:
 *   (a) git ancestry  — `git branch --merged` (fast-forward / merge commit)
 *   (b) git cherry    — patch-equivalent commits (single-commit squash merge)
 *   (c) the PR's state — the only signal that sees a multi-commit squash merge,
 *       and the only one left once the local branch ref is gone
 *
 * A MERGED or CLOSED PR only speaks for the commits it carried. Run branch names
 * are derived from the run identifier and get reused, and removal deletes both the
 * worktree and the branch, so every local tip that still exists (the worktree's
 * HEAD, and the branch ref) must be the PR's head commit or an ancestor of it.
 * Anything past the PR head is unmerged work. With neither left, the PR's state
 * stands alone.
 *
 * 'unjudgeable' is the dead end the git signals hit when the branch ref has been
 * deleted and no PR answers for the branch; 'pr-unavailable' is a PR lookup that
 * failed. Either way the worktree stays, and the caller reports it rather than
 * letting it read as ordinary unmerged work.
 */
type MergeVerdict = 'reclaimable' | 'open-pr' | 'unmerged' | 'unjudgeable' | 'pr-unavailable';

async function judgeBranchForRemoval(input: {
  repoPath: RepoPath;
  branchName: BranchName;
  baseRef: BranchName;
  prStateCache: Map<string, PrLookup>;
  includeClosed: boolean;
  remote: string;
  worktreePath: WorktreePath;
}): Promise<MergeVerdict> {
  const { repoPath, branchName, baseRef, prStateCache, includeClosed, remote, worktreePath } =
    input;
  // Both git signals resolve the local branch ref, and `git cherry` fails outright
  // once it is gone, so ask git only while the ref is there. The PR lookup keys off
  // the branch name on the remote and needs no local ref at all.
  const refExists = await localBranchExists(repoPath, branchName);
  // Removal deletes the worktree too, so its HEAD must be covered by whatever proved
  // the merge. It can differ from the branch tip (a detached HEAD, a branch renamed
  // inside the worktree).
  const hasWorktree = await worktreeExists(worktreePath);
  if (
    refExists &&
    ((await isBranchMerged(repoPath, branchName, baseRef)) ||
      (await isPatchEquivalent(repoPath, branchName, baseRef)))
  ) {
    // `git cherry <base> HEAD` answers for both git signals: an ancestor of the base
    // lists no commits, and a squash-merged commit lists as '-'. A HEAD it cannot
    // settle falls through to the PR, and an unanswerable one throws.
    if (
      !hasWorktree ||
      (await isPatchEquivalent(worktreePath, 'HEAD', baseRef, { throwOnExpectedError: true }))
    ) {
      return 'reclaimable';
    }
  }

  const pr = await getPrState(branchName, repoPath, prStateCache, remote);
  if (pr.state === 'UNAVAILABLE') return 'pr-unavailable';
  if (pr.state === 'NONE') return refExists ? 'unmerged' : 'unjudgeable';
  if (pr.state === 'OPEN') return 'open-pr';
  if (pr.state === 'CLOSED' && !includeClosed) return 'unmerged';
  // isRevCoveredBy fetches the PR head when it was pushed from elsewhere, and throws
  // when that fetch or the comparison fails; the callers report it as a failed merge
  // check and keep the worktree.
  if (hasWorktree && !(await isRevCoveredBy(worktreePath, 'HEAD', pr.headSha, remote))) {
    return 'unmerged';
  }
  if (
    refExists &&
    !(await isRevCoveredBy(repoPath, `refs/heads/${branchName}`, pr.headSha, remote))
  ) {
    return 'unmerged';
  }
  return 'reclaimable';
}

/** The operator-facing reason a kept environment is worth reporting, or null when it is ordinary unmerged work. */
function skipReasonFor(verdict: Exclude<MergeVerdict, 'reclaimable'>): string | null {
  switch (verdict) {
    case 'open-pr':
      return 'PR is open (active review)';
    case 'unjudgeable':
      return 'branch ref is gone and no PR was found — merge state unverifiable';
    case 'pr-unavailable':
      return 'PR state lookup failed — merge state unverifiable';
    case 'unmerged':
      return null;
  }
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
  const report: CleanupReport = { removed: [], skipped: [], errors: [], sessionsDeleted: 0 };

  try {
    // Get all active environments with their codebase info
    const environments = await isolationEnvDb.listAllActiveWithCodebase();
    getLog().info({ count: environments.length }, 'active_environments_found');

    // One PR-state cache for the whole cycle; getPrState keys it by repo + branch,
    // and this sweep spans every registered repo.
    const prStateCache = new Map<string, PrLookup>();

    for (const env of environments) {
      try {
        // Skip if already processing or destroyed
        if (env.status !== 'active') continue;
        const reason = unknownPlatformReason(env.created_by_platform);
        if (reason) {
          report.skipped.push({ id: env.id, reason });
          continue;
        }

        // Check if path still exists
        const pathExists = await worktreeExists(toWorktreePath(env.working_path));
        if (!pathExists) {
          // Even with the directory gone, marking the env destroyed invalidates
          // the live run's resume handle — same lock as the merged/stale branches.
          const liveRun = await isolationEnvDb.getLiveRunOwningEnv(env.id);
          if (liveRun) {
            report.skipped.push({
              id: env.id,
              reason: `path missing but run ${liveRun.id.slice(0, 8)} is ${liveRun.status}`,
            });
            getLog().info(
              { envId: env.id, runId: liveRun.id, runStatus: liveRun.status },
              'skip_path_missing_live_run'
            );
            continue;
          }
          // Path doesn't exist - call removeEnvironment to clean up branch and mark as destroyed
          const removeResult = await removeEnvironment(env.id, { force: false });
          if (removeResult.skippedReason) {
            report.skipped.push({ id: env.id, reason: removeResult.skippedReason });
          } else {
            report.removed.push(`${env.id} (path missing)`);
          }
          continue;
        }

        // Same merged decision the `--merged` sweep uses, PR state included: this
        // repository squash-merges every PR, and git alone cannot see that.
        const mainRepoPath = toRepoPath(env.codebase_default_cwd);
        const { remoteMainRef, remote } = await resolveRepoGitContext(
          mainRepoPath,
          env.codebase_default_cwd
        );
        // A throw here reaches the per-environment catch below, which records the
        // failure and leaves the environment for the next cycle. It must not fall
        // through to the staleness sweep: an unresolved merge check would then be
        // indistinguishable from confirmed-unmerged work and lose its branch to age.
        const verdict = await judgeBranchForRemoval({
          repoPath: mainRepoPath,
          branchName: toBranchName(env.branch_name),
          baseRef: remoteMainRef,
          prStateCache,
          includeClosed: false,
          remote,
          worktreePath: toWorktreePath(env.working_path),
        });

        if (verdict === 'reclaimable') {
          const blocker = await getRemovalBlocker(env);
          if (blocker) {
            report.skipped.push({ id: env.id, reason: `merged but ${blocker.display}` });
            if (blocker.reason === 'live_run') {
              getLog().info(
                { envId: env.id, runId: blocker.runId, runStatus: blocker.runStatus },
                'skip_merged_live_run'
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

        // The staleness sweep below deletes the branch on age alone, so only work
        // git or the PR settled as unmerged may reach it. An open PR or an
        // unverifiable merge state is reported and kept.
        const skipReason = skipReasonFor(verdict);
        if (skipReason) {
          report.skipped.push({ id: env.id, reason: skipReason });
          continue;
        }

        if (retainsWorkspace(env.created_by_platform)) {
          continue;
        }

        // Check if environment is stale
        const isStale = await isEnvironmentStale(env, STALE_THRESHOLD_DAYS);
        if (isStale) {
          const blocker = await getRemovalBlocker(env);
          if (blocker) {
            report.skipped.push({ id: env.id, reason: `stale but ${blocker.display}` });
            if (blocker.reason === 'live_run') {
              getLog().info(
                { envId: env.id, runId: blocker.runId, runStatus: blocker.runStatus },
                'skip_stale_live_run'
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
 * A merged-cleanup result. Carries the base ref the merge decision actually
 * compared against so callers report the repo's configured base branch instead
 * of guessing at one.
 */
export interface MergedCleanupResult extends CleanupOperationResult {
  baseRef: BranchName;
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
  _mainRepoPath: string
): Promise<CleanupOperationResult> {
  const result: CleanupOperationResult = { removed: [], skipped: [] };
  getRegisteredPlatformPolicies();
  const environments = await isolationEnvDb.listByCodebaseWithAge(codebaseId);

  for (const env of environments) {
    const reason = unknownPlatformReason(env.created_by_platform);
    if (reason) {
      result.skipped.push({ branchName: env.branch_name, reason });
      continue;
    }
    if (retainsWorkspace(env.created_by_platform)) continue;

    // Check if stale
    if (env.days_since_activity < STALE_THRESHOLD_DAYS) continue;

    // Check for uncommitted changes or a live owning run
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
 * Clean up merged worktrees for a codebase
 * Respects uncommitted changes and live workflow runs
 */
export async function cleanupMergedWorktrees(
  codebaseId: string,
  mainRepoPath: string,
  options: { includeClosed?: boolean } = {}
): Promise<MergedCleanupResult> {
  getRegisteredPlatformPolicies();
  const environments = await isolationEnvDb.listByCodebase(codebaseId);
  const repoPath = toRepoPath(mainRepoPath);
  const { remoteMainRef, remote } = await resolveRepoGitContext(repoPath, mainRepoPath);
  const result: MergedCleanupResult = { removed: [], skipped: [], baseRef: remoteMainRef };
  const includeClosed = options.includeClosed ?? false;
  const prStateCache = new Map<string, PrLookup>();

  for (const env of environments) {
    const reason = unknownPlatformReason(env.created_by_platform);
    if (reason) {
      result.skipped.push({ branchName: env.branch_name, reason });
      continue;
    }
    let verdict: MergeVerdict;
    try {
      verdict = await judgeBranchForRemoval({
        repoPath,
        branchName: toBranchName(env.branch_name),
        baseRef: remoteMainRef,
        prStateCache,
        includeClosed,
        remote,
        worktreePath: toWorktreePath(env.working_path),
      });
    } catch (error) {
      const err = error as Error;
      // Log before skipping — silent skips make transient git/network failures
      // impossible to debug from the cleanup report alone.
      getLog().warn(
        { err, branchName: env.branch_name, repoPath: mainRepoPath },
        'cleanup.merge_check_failed'
      );
      result.skipped.push({
        branchName: env.branch_name,
        reason: `merge check failed: ${err.message}`,
      });
      continue;
    }
    if (verdict !== 'reclaimable') {
      const reason = skipReasonFor(verdict);
      if (reason) result.skipped.push({ branchName: env.branch_name, reason });
      continue;
    }

    // Check for uncommitted changes or a live owning run
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

/**
 * Check if scheduler is running (for testing)
 */
export function isSchedulerRunning(): boolean {
  return cleanupIntervalId !== null;
}

export interface ReleasedWorktree {
  path: string;
  branch: string;
}

export interface RunWorktreeRelease {
  released?: ReleasedWorktree;
  warnings: string[];
}

async function reclaimOwnedWorktree(
  run: WorkflowRun,
  store: IIsolationStore,
  readers: {
    getCodebase: typeof codebaseDb.getCodebase;
    getLiveRunOwningEnv: typeof isolationEnvDb.getLiveRunOwningEnv;
  }
): Promise<RunWorktreeRelease> {
  const proof = readOwnedWorktree(run.metadata);
  if (!proof) {
    if (run.metadata?.isolation === 'container') return { warnings: [] };
    const codebase = run.codebase_id ? await readers.getCodebase(run.codebase_id) : null;
    if (codebase?.kind === 'folder') return { warnings: [] };
    return {
      warnings: run.working_path
        ? [
            `Retained checkout ${run.working_path} for run ${run.id}: no valid proof this run created it. Inspect it and use explicit isolation cleanup if appropriate.`,
          ]
        : [],
    };
  }
  const refuse = (reason: string): never => {
    throw new Error(reason);
  };
  const env = await store.getById(proof.envId);
  if (
    env?.provider !== 'worktree' ||
    env.codebase_id !== run.codebase_id ||
    env.working_path !== run.working_path ||
    readWorktreeCreationId(env.metadata) !== proof.creationId
  ) {
    return refuse('creation proof does not match its isolation record');
  }
  const reason = unknownPlatformReason(env.created_by_platform);
  if (reason) return refuse(reason);
  const codebase = run.codebase_id ? await readers.getCodebase(run.codebase_id) : null;
  if (!codebase) return refuse('canonical repository is unavailable');
  const repo = toRepoPath(codebase.default_cwd);
  const path = toWorktreePath(env.working_path);
  const pathExists = async (): Promise<boolean> => {
    try {
      await lstat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return false;
    }
  };
  if (!(await pathExists())) {
    if (await isWorktreeRegistered(repo, path))
      return refuse('checkout is absent but still registered with Git');
    if (env.status !== 'destroyed') await store.updateStatus(env.id, 'destroyed');
    return { warnings: [] };
  }
  if (env.status === 'destroyed')
    return refuse('a path exists for an already destroyed environment');
  let marked = false;
  try {
    const result = await getIsolationProvider().destroy(path, {
      canonicalRepoPath: repo,
      guardedRemoval: {
        creationId: proof.creationId,
        // The record is marked destroyed before the claimant check, so a run that
        // reused it after this point fails claimPendingWorkflowRun instead of
        // starting in a checkout that is about to disappear.
        beforeRemove: async () => {
          await store.updateStatus(env.id, 'destroyed');
          marked = true;
          const user = await readers.getLiveRunOwningEnv(env.id);
          if (user) refuse(`claimable run ${user.id} (${user.status}) also uses this checkout`);
        },
      },
    });
    if (!result.worktreeRemoved || !result.directoryClean)
      return refuse('filesystem removal incomplete');
    return { released: { path, branch: env.branch_name }, warnings: result.warnings };
  } catch (err) {
    if (marked && (await pathExists())) await store.updateStatus(env.id, 'active');
    throw err;
  }
}

/**
 * Remove the worktree an abandoned run created, discarding uncommitted work.
 * The branch is kept, so committed work stays recoverable.
 */
export async function reclaimRunWorktree(
  run: WorkflowRun,
  store: IIsolationStore,
  readers = {
    getCodebase: codebaseDb.getCodebase,
    getLiveRunOwningEnv: isolationEnvDb.getLiveRunOwningEnv,
  }
): Promise<RunWorktreeRelease> {
  try {
    return await reclaimOwnedWorktree(run, store, readers);
  } catch (err) {
    const proof = readOwnedWorktree(run.metadata);
    // A leftover Git no longer tracks cannot be finished by a retry; its message says so.
    const next =
      err instanceof WorktreeLeftoverError
        ? ''
        : `. Fix the cause and retry workflow abandon ${run.id}.`;
    throw new Error(
      `Could not release worktree for run ${run.id}, environment ${proof?.envId ?? '(unaccounted)'}, checkout ${run.working_path ?? '(missing)'}: ${(err as Error).message}${next}`,
      { cause: err }
    );
  }
}
