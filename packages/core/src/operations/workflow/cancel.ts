import { ISOLATION_ENV_ID_METADATA_KEY } from '@archon/workflows/schemas/run-metadata';
import { releaseRunScratch } from '@archon/workflows/run-scratch';
import { COMPLETED_HOST_COMMAND_WARNING } from '@archon/workflows/host-command-cleanup';
import { isContainerRun } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { RunActor } from '../run-authorization';
import { releaseRunResources, type OperationContext } from './context';
import {
  cancelByOperator,
  describeAbandonOwner,
  recordAbandoned,
  rootRunIdOf,
  stopLiveOwner,
  type AbandonOwnerOutcome,
  type AbandonWorkflowResult,
} from './teardown';

/**
 * Why cancel left a run unchanged.
 *
 * `not_running`: the run is neither pending nor running.
 * `starting`: the run has not started, but a live process is starting it, or it started
 *   while cancel was recording. Cancel does not guess which process owns it.
 * `no_owner_answered`: nothing answered at the run's live-owner endpoint on this host.
 *   Cancel never records `cancelled` for a run it cannot prove stopped; abandon is the
 *   operator's explicit call that the run is dead, so surfaces point there.
 * `not_stopped`: an owner answered but could not be stopped, or its container could not
 *   be confirmed.
 */
export type CancelRefusal = 'not_running' | 'starting' | 'no_owner_answered' | 'not_stopped';

/** Cancel refused; the run is unchanged. The message states why. */
export class CancelRefusedError extends Error {
  constructor(
    readonly reason: CancelRefusal,
    message: string
  ) {
    super(message);
    this.name = 'CancelRefusedError';
  }
}

/**
 * `cooperative`: the run's executor stops at its next status check. Either this
 * process executes the run, or the run is a `workflow:` sub-run with no live owner of
 * its own whose root run's owner answers: it executes inside that process while the
 * root's row keeps the worktree lock and resource slot. `cancelled` is false when the run finished first.
 * `stopped`: another live process owned the run; its process was stopped, with any output-holder warnings reported
 * before the run was recorded `cancelled`.
 * `pending`: the run had not started and no process was starting it; this call recorded
 * it `cancelled`, so its start never runs. Nothing ran, so no checkout or host command is
 * reported.
 */
export type CancelWorkflowResult =
  | { kind: 'cooperative'; run: WorkflowRun; cancelled: boolean; cleanupWarnings?: string[] }
  | { kind: 'pending'; run: WorkflowRun; cleanupWarnings?: string[] }
  | ({ kind: 'stopped'; pid: number } & Omit<AbandonWorkflowResult, 'cancelled'>);

/**
 * The container a cancelled run owns, confirmed before its owner is stopped so a run
 * whose container cannot be accounted for is refused while it is still unchanged.
 */
async function confirmedRunContainer(
  ctx: OperationContext,
  run: WorkflowRun
): Promise<string | undefined> {
  if (!isContainerRun(run)) return undefined;
  const envId = run.metadata?.[ISOLATION_ENV_ID_METADATA_KEY];
  if (typeof envId !== 'string' || envId.trim().length === 0) {
    throw new CancelRefusedError(
      'not_stopped',
      `Cannot confirm the isolation container owned by run ${run.id}. ` +
        'The run was not changed; its container tracking ID is missing.'
    );
  }
  const env = await ctx.hostStore.isolation.getById(envId);
  if (env?.provider !== 'container') {
    throw new CancelRefusedError(
      'not_stopped',
      `Cannot confirm the isolation container owned by run ${run.id}. ` +
        'The run was not changed; inspect the managed containers before retrying or abandoning it.'
    );
  }
  return envId;
}

/** A pending run is withdrawn before it starts; a running run has live work to stop. */
export function isCancellableRun(run: Pick<WorkflowRun, 'status'>): boolean {
  return run.status === 'pending' || run.status === 'running';
}

/**
 * Cancel a pending or running run, the same way on every surface.
 *
 * - Pending, and no owner answers for it (or, for a sub-run, for its root): record
 *   `cancelled` while it is still pending (see {@link cancelPendingRun}).
 * - This process executes it, or it is a sub-run with no live owner of its own whose
 *   root's owner answers: cooperative cancel (see {@link CancelWorkflowResult}).
 * - Another live process owns it, sub-run or not: stop that owner through the shared stop path
 *   (prove it, terminate its process tree, wait), then record `cancelled`.
 * - No owner answers, or the owner cannot be stopped: refuse with
 *   {@link CancelRefusedError} and leave the run unchanged. `cancelled` releases the
 *   run's worktree lock and resource slot, so it is never recorded on a guess.
 */
export async function cancelWorkflow(
  ctx: OperationContext,
  runId: string,
  actor: RunActor
): Promise<CancelWorkflowResult> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_cancel_lookup_failed');
  await ctx.assertMayAct(run, actor, 'cancel');
  if (!isCancellableRun(run)) {
    throw new CancelRefusedError(
      'not_running',
      `Cannot cancel run with status '${run.status}'. Only a pending or running run can be cancelled; ` +
        'abandon a paused or failed run instead.'
    );
  }
  if (run.status === 'pending') return cancelPendingRun(ctx, run);

  if (ctx.isRunOwnedByThisProcess(run.id)) return cooperativeCancel(ctx, run);

  const containerEnvId = await confirmedRunContainer(ctx, run);
  const owner = await stopLiveOwner(ctx, run);
  if (owner.kind === 'not_stopped') throw new CancelRefusedError('not_stopped', owner.message);
  if (owner.kind === 'no_owner_answered') return cancelWithoutOwner(ctx, run, owner);

  if (containerEnvId) {
    try {
      await ctx.reclaimContainerEnv(containerEnvId, ctx.hostStore.isolation);
    } catch (error) {
      throw new CancelRefusedError(
        'not_stopped',
        'The owner process stopped, but the isolation container could not be confirmed stopped. ' +
          `Run state was not changed. ${(error as Error).message}`
      );
    }
  }

  const { cancelled, ...recorded } = await recordAbandoned(ctx, run, owner.cleanupWarnings);
  if (!cancelled) {
    const latest = await ctx.store.getWorkflowRun(run.id);
    throw new Error(
      'The owner process stopped, but cancellation did not win the run state transition. ' +
        `The run status is ${latest?.status ?? 'unknown'}; it was not reported as cancelled.`
    );
  }
  const cleanupWarnings = [...(recorded.cleanupWarnings ?? [])];
  // An output holder the stop left running may still write scratch.
  if (!owner.cleanupWarnings?.length) {
    await releaseRunScratch(run);
    cleanupWarnings.push(...(await releaseRunResources(ctx, run.id)));
  }
  return {
    kind: 'stopped',
    pid: owner.pid,
    ...recorded,
    ...(cleanupWarnings.length ? { cleanupWarnings } : {}),
  };
}

/**
 * A pending run has not started. Every process that prepares one publishes a live-owner
 * endpoint first; a sub-run publishes none and is claimed by its root's process. So when
 * nothing answers for the run or its root, no process is starting it, and the pending-only
 * write is safe: a start claims only a pending run, so a won write means it never runs.
 * Nothing executed, so there is no owner to stop, checkout to reclaim or child to cascade.
 */
async function cancelPendingRun(
  ctx: OperationContext,
  run: WorkflowRun
): Promise<CancelWorkflowResult> {
  const startingMessage = (ownerRunId: string): string =>
    `Run ${run.id} has not started, but a live process is starting ` +
    `${ownerRunId === run.id ? 'it' : `it under root run ${ownerRunId}`}. The run was not changed. ` +
    'Cancel it again once it is running, or stop that process.';
  if (ctx.isRunOwnedByThisProcess(run.id) || (await ctx.isRunOwnerAnswering(run.id)))
    throw new CancelRefusedError('starting', startingMessage(run.id));
  const rootRunId = run.parent_run_id ? await rootRunIdOf(ctx, run.id) : undefined;
  if (rootRunId && (await ctx.isRunOwnerAnswering(rootRunId)))
    throw new CancelRefusedError('starting', startingMessage(rootRunId));

  const { cancelled } = await ctx.store.cancelWorkflowRun(
    run.id,
    { cancel_reason: 'operator' },
    { pendingOnly: true }
  );
  if (!cancelled) {
    const latest = await ctx.store.getWorkflowRun(run.id);
    if (latest?.status === 'running') {
      throw new CancelRefusedError(
        'starting',
        `Run ${run.id} started while cancel was recording; it was not cancelled. Run cancel again to stop it.`
      );
    }
    throw new CancelRefusedError(
      'not_running',
      `Run ${run.id} is now ${latest?.status ?? 'gone'}; nothing to cancel.`
    );
  }
  await releaseRunScratch(run);
  const cleanupWarnings = await releaseRunResources(ctx, run.id);
  return { kind: 'pending', run, ...(cleanupWarnings.length ? { cleanupWarnings } : {}) };
}

/**
 * A sub-run normally executes inside its root run's process and publishes no endpoint
 * of its own, so its own silence proves nothing either way. The root's owner decides:
 * when it answers, the root's executor sees the status change at its next check, and
 * the root's row keeps the worktree lock and resource slot. The sub-run's recorded
 * owner cannot decide this: the executor stamps every run it executes, nested or not.
 */
async function cancelWithoutOwner(
  ctx: OperationContext,
  run: WorkflowRun,
  owner: Extract<AbandonOwnerOutcome, { kind: 'no_owner_answered' }>
): Promise<CancelWorkflowResult> {
  const rootRunId = run.parent_run_id ? await rootRunIdOf(ctx, run.id) : undefined;
  if (rootRunId && (await ctx.isRunOwnerAnswering(rootRunId))) return cooperativeCancel(ctx, run);
  throw new CancelRefusedError(
    'no_owner_answered',
    [
      ...describeAbandonOwner(owner),
      ...(rootRunId
        ? [`No live owner answered for its root run ${rootRunId} on this host either.`]
        : []),
      `Cancel has nothing to stop, so run ${run.id} was not changed. ` +
        'If its process is gone, abandon the run to release it.',
    ].join('\n')
  );
}

async function cooperativeCancel(
  ctx: OperationContext,
  run: WorkflowRun
): Promise<CancelWorkflowResult> {
  const warnings = process.platform !== 'win32' ? await hostCommandWarnings(ctx, run) : [];
  const { cancelled } = await cancelByOperator(ctx, run.id, warnings);
  return {
    kind: 'cooperative',
    run,
    cancelled,
    ...(cancelled && warnings.length ? { cleanupWarnings: warnings } : {}),
  };
}

async function hostCommandWarnings(ctx: OperationContext, run: WorkflowRun): Promise<string[]> {
  const warnings: string[] = [];
  if (!isContainerRun(run)) {
    // History reads cannot exclude commands admitted before the cancellation commits.
    warnings.push(
      `Run ${run.id} checkout ${JSON.stringify(run.working_path)}: ${COMPLETED_HOST_COMMAND_WARNING} ` +
        'Cooperative cancellation cannot rule out host commands starting during cancellation, ' +
        'including in new descendant runs. Inspect descendant checkouts too.'
    );
  }
  for (const child of await ctx.store.findChildRuns(run.id)) {
    warnings.push(...(await hostCommandWarnings(ctx, child)));
  }
  return warnings;
}
