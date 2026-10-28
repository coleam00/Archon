import { hostname } from 'node:os';
import { releaseRunScratch } from '@archon/workflows/run-scratch';
import {
  CANCELLATION_NOOP_WORKFLOW_STATUSES,
  isContainerRun,
  isRunBlockedOnChild,
  readExecutionOwner,
} from '@archon/workflows/schemas/workflow-run';
import type { ExecutionOwnerRecord, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { ReleasedWorktree } from '../../services/cleanup/run-worktree';
import {
  DetachedRunOwnerUnavailableError,
  type DetachedRunStopTarget,
} from '../../services/run-owner-stop';
import { getLog, type OperationContext } from './context';

/** Maximum parent expansions in the abandon tree walks. */
export const MAX_CASCADE_RUNS = 500;

/**
 * What abandon found at the run's live-owner endpoint before it recorded `cancelled`.
 *
 * `stopped`: an owner answered and its process was stopped, with any output-holder warnings reported.
 * `no_owner_answered`: nothing is listening at the endpoint on this host. Recording
 * `cancelled` is then the operator's explicit call that the run is dead, so the
 * recorded facts travel with the result for every surface to show.
 */
export type AbandonOwnerOutcome =
  | { kind: 'stopped'; pid: number; cleanupWarnings?: string[] }
  | {
      kind: 'no_owner_answered';
      /** The connection error that showed nothing answered. */
      detail: string;
      /** Host and pid of the process that last executed the run; absent on older runs. */
      recordedOwner: ExecutionOwnerRecord | undefined;
      lastActivityAt: Date | null;
      /** The host abandon ran on, which is the only host whose endpoint it could ask. */
      thisHost: string;
      /** The user abandon ran as; its endpoint directory is scoped to this uid on POSIX. */
      thisUid: number | undefined;
    };

/**
 * Operator-facing lines describing the owner outcome, shared by every abandon surface
 * so none of them words the cross-host warning differently.
 */
export function describeAbandonOwner(outcome: AbandonOwnerOutcome): string[] {
  if (outcome.kind === 'stopped') {
    return [
      `Stopped the run's live owner process (pid ${String(outcome.pid)}) first.`,
      ...(outcome.cleanupWarnings ?? []),
    ];
  }
  const lines = [
    `No live owner answered for this run on this host (${outcome.thisHost}; ${outcome.detail}).`,
  ];
  const recorded = outcome.recordedOwner;
  lines.push(
    recorded
      ? `Recorded owner: host ${recorded.host}, pid ${String(recorded.pid)}.`
      : 'Recorded owner: none (the run predates owner recording).'
  );
  lines.push(
    `Last activity: ${outcome.lastActivityAt ? outcome.lastActivityAt.toISOString() : 'none recorded'}.`
  );
  if (recorded && recorded.host !== outcome.thisHost) {
    lines.push(
      `The recorded owner is on another host (${recorded.host}). Abandon cannot reach or stop a process there; ` +
        'if it is still running, it keeps running after this run is marked cancelled.'
    );
  } else if (
    recorded?.uid !== undefined &&
    outcome.thisUid !== undefined &&
    recorded.uid !== outcome.thisUid
  ) {
    lines.push(
      `The recorded owner ran as another user (uid ${String(recorded.uid)}), and abandon runs as ` +
        `uid ${String(outcome.thisUid)}. Abandon can only reach owners running as its own user; ` +
        'if it is still running, it keeps running after this run is marked cancelled.'
    );
  }
  return lines;
}

export interface AbandonWorkflowResult {
  run: WorkflowRun;
  /** Whether this call won the state transition to `cancelled`. */
  cancelled: boolean;
  /**
   * Number of sub-run descendants the cascade failed to cancel (best-effort walk;
   * failures are also logged). Non-zero means part of the tree may still be alive.
   */
  cascadeFailures: number;
  cleanupWarnings?: string[];
  /** Worktrees removed because their run was abandoned; each branch is kept. */
  releasedWorktrees?: ReleasedWorktree[];
  /**
   * When the abandoned run was itself a `workflow:` sub-run and its parent is
   * paused blocked on it: the parent's run id. Nothing auto-resumes that parent
   * (the hook only fires from inside the child's own execution) — the user should
   * resume it (it reads this sub-run's outcome) or abandon it too.
   */
  blockedParentRunId: string | null;
}

export interface AbandonAttemptResult extends AbandonWorkflowResult {
  cancelledRuns: WorkflowRun[];
}

export function ownerNotStoppedMessage(
  runId: string,
  error: DetachedRunOwnerUnavailableError
): string {
  switch (error.reason) {
    case 'not_detached':
      return (
        `Run ${runId} is executing in another live Archon process that cannot be stopped from here, ` +
        'because it is not a detached run (a foreground CLI run, or an Archon server). ' +
        'The run was not changed. Stop it from that process: interrupt the foreground command, ' +
        'or cancel the run on the server that executes it.'
      );
    case 'unproven':
      return (
        `Something answered at run ${runId}'s owner endpoint, but it could not be proven to be ` +
        `the run's owner (${error.detail}). The run was not changed.`
      );
    case 'unreachable':
    case undefined:
      return (
        `Could not ask run ${runId}'s owner endpoint whether an owner is live ` +
        `(${error.detail}). The run was not changed.`
      );
  }
}

/**
 * Cascade-cancel the `workflow:` sub-run tree under `rootId` (#2121 Phase 2 / D7).
 * A child sub-run shares the parent's conversation and runs in-process, so
 * abandoning the parent walks descendants up to the expansion cap (a child
 * may itself spawn grandchildren). Best-effort — a per-run failure is logged, never
 * thrown, so the parent abandon always succeeds; the failure COUNT is returned so
 * callers can tell the user part of the tree may still be alive.
 */
export async function cascadeCancelChildren(
  ctx: OperationContext,
  rootId: string
): Promise<{ failures: number; runs: WorkflowRun[] }> {
  const queue: string[] = [rootId];
  const seen = new Set<string>([rootId]);
  let processed = 0;
  const runs: WorkflowRun[] = [];
  let failures = 0;
  while (queue.length > 0 && processed < MAX_CASCADE_RUNS) {
    const parentId = queue.shift();
    if (parentId === undefined) break;
    processed++;
    let children: WorkflowRun[];
    try {
      children = await ctx.store.findChildRuns(parentId);
    } catch (err) {
      getLog().warn({ err, parentId }, 'operations.workflow_abandon_cascade_lookup_failed');
      failures++;
      continue;
    }
    const batch = await cancelUnseenChildren(ctx, children, seen, queue);
    runs.push(...batch.cancelled);
    failures += batch.failures;
  }
  // Queued runs were already considered for cancellation; only their children
  // remain unvisited. Probe after cancellation so a wide leaf level is all-clear.
  if (queue.length > 0) {
    try {
      const { total } = await ctx.store.listWorkflowRuns({
        parentRunIds: queue,
        excludeLeafStatuses: [...CANCELLATION_NOOP_WORKFLOW_STATUSES],
        limit: 0,
      });
      if (total > 0) {
        getLog().warn(
          { rootId, cap: MAX_CASCADE_RUNS, unreached: total, pendingParents: queue.length },
          'operations.workflow_abandon_cascade_truncated'
        );
        failures += total;
      }
    } catch (err) {
      getLog().warn(
        { err, rootId, pendingParents: queue.length },
        'operations.workflow_abandon_cascade_lookup_failed'
      );
      failures++;
    }
  }
  return { failures, runs };
}

/** Cancel each child not yet seen and queue it for the walk, terminal or not. */
async function cancelUnseenChildren(
  ctx: OperationContext,
  children: readonly WorkflowRun[],
  seen: Set<string>,
  queue: string[]
): Promise<{ cancelled: WorkflowRun[]; failures: number }> {
  const cancelled: WorkflowRun[] = [];
  let failures = 0;
  for (const child of children) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    queue.push(child.id); // traverse deeper even under an already-terminal child
    if (CANCELLATION_NOOP_WORKFLOW_STATUSES.includes(child.status)) continue;
    const outcome = await cancelCascadeChild(ctx, child.id);
    if (outcome === 'cancelled') cancelled.push(child);
    else if (outcome === 'failed') failures++;
  }
  return { cancelled, failures };
}

/**
 * Cancel one cascade child. A lost cancel whose re-read shows the child already
 * settled (completed or cancelled meanwhile) is not a failure.
 */
async function cancelCascadeChild(
  ctx: OperationContext,
  childId: string
): Promise<'cancelled' | 'settled' | 'failed'> {
  try {
    const result = await cancelByOperator(ctx, childId);
    if (result.cancelled) return 'cancelled';
    const current = await ctx.store.getWorkflowRun(childId);
    if (current && CANCELLATION_NOOP_WORKFLOW_STATUSES.includes(current.status)) return 'settled';
    getLog().warn({ childId }, 'operations.workflow_abandon_cascade_cancel_failed');
  } catch (err) {
    getLog().warn({ err, childId }, 'operations.workflow_abandon_cascade_cancel_failed');
  }
  return 'failed';
}

/**
 * If `run` is a `workflow:` sub-run whose PARENT is currently paused blocked on it —
 * a 1:1 child, or one of the children a fan-out waits on — return the parent's run
 * id. Abandoning the child strands that parent (nothing re-fires the auto-resume hook
 * for a terminal-via-abandon child), so callers must tell the user to resume it (it
 * reads this child's outcome) or abandon the parent too.
 * Best-effort: lookup failures are logged and read as "no blocked parent".
 */
export async function findParentBlockedOn(
  ctx: OperationContext,
  run: WorkflowRun
): Promise<string | null> {
  if (!run.parent_run_id) return null;
  try {
    const parent = await ctx.store.getWorkflowRun(run.parent_run_id);
    // Shared invariant (isRunBlockedOnChild) — same predicate the auto-resume hook
    // uses, so the two can't drift if the child_workflow gate shape changes.
    if (parent && isRunBlockedOnChild(parent, run.id)) return parent.id;
    return null;
  } catch (err) {
    getLog().warn(
      { err, runId: run.id, parentRunId: run.parent_run_id },
      'operations.workflow_abandon_parent_lookup_failed'
    );
    return null;
  }
}

/** Reclaim a container owned by a run this process successfully cancelled. */
export async function reclaimCancelledRunContainer(
  ctx: OperationContext,
  run: WorkflowRun
): Promise<string[]> {
  if (!isContainerRun(run) || typeof run.metadata?.isolation_env_id !== 'string') {
    return [];
  }
  try {
    await ctx.reclaimContainerEnv(run.metadata.isolation_env_id, ctx.hostStore.isolation);
  } catch (err) {
    getLog().warn({ err, runId: run.id }, 'operations.workflow_abandon_container_reclaim_failed');
    return [
      `Could not reclaim container environment ${run.metadata.isolation_env_id} for run ${run.id}; resources may remain allocated. Inspect the managed containers before retrying cleanup.`,
    ];
  }
  return [];
}

export async function cancelRunAndCleanup(
  ctx: OperationContext,
  run: WorkflowRun,
  stopWarnings: string[] = []
): Promise<AbandonAttemptResult> {
  let cancelled: boolean;
  try {
    ({ cancelled } = await cancelByOperator(ctx, run.id, stopWarnings));
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, runId: run.id },
      'operations.workflow_abandon_failed'
    );
    throw new Error(`Failed to abandon workflow run ${run.id}: ${err.message}`);
  }

  let cascadeFailures = 0;
  let cancelledRuns: WorkflowRun[] = [];
  if (cancelled) {
    ({ failures: cascadeFailures, runs: cancelledRuns } = await cascadeCancelChildren(ctx, run.id));
    // An output holder the stop left running may still write a descendant's scratch.
    if (!stopWarnings.length) for (const child of cancelledRuns) await releaseRunScratch(child);
  }
  const blockedParentRunId = cancelled ? await findParentBlockedOn(ctx, run) : null;

  // Reclaim only when our cancel won the CAS. A miss means another lifecycle
  // owner now controls the run and its environment.
  const cleanupWarnings = [
    ...stopWarnings,
    ...(cancelled ? await reclaimCancelledRunContainer(ctx, run) : []),
  ];
  return {
    run,
    cancelled,
    cancelledRuns,
    cascadeFailures,
    blockedParentRunId,
    ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
  };
}

/**
 * Stop the run's live owner through the shared stop path, or report that none answered.
 * `not_stopped` means an owner answered but could not be stopped, or the endpoint could
 * not be asked; nothing about the run has changed. Cancel and abandon each translate it
 * into their own error.
 */
export async function stopLiveOwner(
  ctx: OperationContext,
  run: WorkflowRun
): Promise<AbandonOwnerOutcome | { kind: 'not_stopped'; message: string }> {
  let target: DetachedRunStopTarget;
  try {
    target = await ctx.requestDetachedRunStop(run.id);
  } catch (error) {
    if (!(error instanceof DetachedRunOwnerUnavailableError)) throw error;
    if (error.reason === 'unreachable') {
      return {
        kind: 'no_owner_answered',
        detail: error.detail,
        recordedOwner: readExecutionOwner(run.metadata),
        lastActivityAt: run.last_activity_at,
        thisHost: hostname(),
        thisUid: process.getuid?.(),
      };
    }
    return { kind: 'not_stopped', message: ownerNotStoppedMessage(run.id, error) };
  }
  try {
    const warnings = (await target.stop()).warnings;
    return {
      kind: 'stopped',
      pid: target.pid,
      ...(warnings.length ? { cleanupWarnings: warnings } : {}),
    };
  } catch (error) {
    return {
      kind: 'not_stopped',
      message:
        `Could not stop the live owner of run ${run.id} (pid ${String(target.pid)}): ` +
        `${(error as Error).message}. The run was not changed.`,
    };
  }
}

/** Every cancel and abandon here is an operator's request, whichever surface sent it. */
export function cancelByOperator(
  ctx: OperationContext,
  runId: string,
  warnings: string[] = []
): Promise<{ cancelled: boolean }> {
  return ctx.store.cancelWorkflowRun(runId, {
    cancel_reason: 'operator',
    ...(warnings.length ? { reason: warnings.join('\n'), warnings } : {}),
  });
}

export async function recordAbandoned(
  ctx: OperationContext,
  run: WorkflowRun,
  stopWarnings: string[] = []
): Promise<AbandonWorkflowResult> {
  const result = await cancelRunAndCleanup(ctx, run, stopWarnings);
  return {
    run: result.run,
    cancelled: result.cancelled,
    cascadeFailures: result.cascadeFailures,
    blockedParentRunId: result.blockedParentRunId,
    ...(result.cleanupWarnings ? { cleanupWarnings: result.cleanupWarnings } : {}),
  };
}
