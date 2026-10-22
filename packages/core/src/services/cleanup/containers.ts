// Container isolation environments (folder-project container backend).
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { ContainerBackend } from '@archon/isolation';
import type { ContainerBackendConfig, IIsolationStore } from '@archon/isolation';
import {
  getRegisteredPlatformPolicies,
  retainsWorkspace,
  unknownPlatformReason,
} from '../../platforms/registry';
import * as isolationEnvDb from '../../db/isolation-environments';
import * as workflowDb from '../../db/workflows';
import { getLiveRunBlocker, type LiveRunBlocker } from './run-lock';
import { getLog } from './log';

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
  runStatus: WorkflowRunStatus | 'lookup-failed' | null;
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
    // Failed reads leave ownership unknown; null would misreport an orphan.
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
export async function reapContainerEnvironments(
  daysStale: number
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
    let liveRun: LiveRunBlocker | null;
    try {
      liveRun = await getLiveRunBlocker(row.id);
    } catch (err) {
      report.errors.push({
        id: row.id,
        error: `run lookup failed (NOT reaped): ${(err as Error).message}`,
      });
      getLog().warn({ err, envId: row.id }, 'container_env_reap_lookup_failed');
      continue;
    }
    if (liveRun) {
      report.skipped.push({ id: row.id, reason: liveRun.display });
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
