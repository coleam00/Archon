import { releaseRunScratch } from '@archon/workflows/run-scratch';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { RunActor } from '../run-authorization';
import { runWritersStopped } from './abandon';
import type { OperationContext } from './context';
import {
  cancelByOperator,
  describeAbandonOwner,
  recordAbandoned,
  stopLiveOwner,
  type AbandonOwnerOutcome,
  type AbandonWorkflowResult,
} from './teardown';

/**
 * Why cancel left a run unchanged.
 *
 * `not_running`: only a running run has live work to stop.
 * `no_owner_answered`: nothing answered at the run's live-owner endpoint on this host.
 *   Cancel never records `cancelled` for a run it cannot prove stopped; abandon is the
 *   operator's explicit call that the run is dead, so surfaces point there.
 * `not_stopped`: an owner answered but could not be stopped, or its container could not
 *   be confirmed.
 */
export type CancelRefusal = 'not_running' | 'no_owner_answered' | 'not_stopped';

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
 */
export type CancelWorkflowResult =
  | { kind: 'cooperative'; run: WorkflowRun; cancelled: boolean }
  | ({ kind: 'stopped'; pid: number } & Omit<AbandonWorkflowResult, 'cancelled'>);

/**
 * The container a cancelled run owns, confirmed before its owner is stopped so a run
 * whose container cannot be accounted for is refused while it is still unchanged.
 */
async function confirmedRunContainer(
  ctx: OperationContext,
  run: WorkflowRun
): Promise<string | undefined> {
  if (run.metadata?.isolation !== 'container') return undefined;
  const envId = run.metadata.isolation_env_id;
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

/**
 * Cancel a running run, the same way on every surface.
 *
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
  if (run.status !== 'running') {
    throw new CancelRefusedError(
      'not_running',
      `Cannot cancel run with status '${run.status}'. Only a running run has live work to stop; ` +
        'abandon a paused or failed run instead.'
    );
  }

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
  if (runWritersStopped(run, owner)) await releaseRunScratch(run);
  return { kind: 'stopped', pid: owner.pid, ...recorded };
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

/** The top of `runId`'s `parent_run_id` chain; undefined when no ancestor row remains. */
async function rootRunIdOf(ctx: OperationContext, runId: string): Promise<string | undefined> {
  return (await ctx.store.getRunAncestry(runId)).at(-1)?.id;
}

async function cooperativeCancel(
  ctx: OperationContext,
  run: WorkflowRun
): Promise<CancelWorkflowResult> {
  const { cancelled } = await cancelByOperator(ctx, run.id);
  return { kind: 'cooperative', run, cancelled };
}
