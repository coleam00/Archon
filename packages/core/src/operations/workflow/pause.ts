import {
  OPERATOR_PAUSE_METADATA_KEY,
  operatorPause,
  type OperatorPause,
} from '@archon/workflows/schemas/operator-pause';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import { readExecutionOwner, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { itemAct } from '../item-act';
import type { RunActor } from '../run-authorization';
import type { OperationContext } from './context';
import { unreachableOwner } from './run-actions';
import { rootRunIdOf } from './teardown';

/**
 * Why pause left a run unchanged.
 *
 * `not_running`: only a running run has a node boundary ahead of it.
 * `sub_run`: a sub-run executes inside its root run's node; the root is paused instead.
 * `no_owner_answered`: nothing answered at the run's live-owner endpoint on this host, so
 *   no executor would reach a boundary to honour the request.
 * `owner_unreachable`: the recorded owner runs on another host or as another user.
 */
export type PauseRefusal = 'not_running' | 'sub_run' | 'no_owner_answered' | 'owner_unreachable';

/** Pause refused; the run is unchanged. The message states why. */
export class PauseRefusedError extends Error {
  constructor(
    readonly reason: PauseRefusal,
    message: string
  ) {
    super(message);
    this.name = 'PauseRefusedError';
  }
}

/** The recorded request; `alreadyRequested` when an earlier one was pending and nothing was written. */
export interface PauseWorkflowResult {
  run: WorkflowRun;
  requested: OperatorPause['requested'];
  alreadyRequested: boolean;
}

/**
 * Ask the executor that owns a running run to pause it at its next node boundary. Only
 * the request is recorded here: the nodes running now finish, the executor starts no node
 * after them and moves the run to `paused` itself. The request is recorded only while an
 * owner answers, so it never lands on a run nothing executes.
 */
export async function pauseWorkflow(
  ctx: OperationContext,
  runId: string,
  actor: RunActor,
  via: RecordSurface
): Promise<PauseWorkflowResult> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_pause_lookup_failed');
  await ctx.assertMayAct(run, actor, 'pause');
  if (run.parent_run_id) {
    const rootRunId = (await rootRunIdOf(ctx, run.id)) ?? run.parent_run_id;
    throw new PauseRefusedError(
      'sub_run',
      `Run ${run.id} is a sub-run; it runs inside a node of its root run ${rootRunId}. ` +
        `Pause the root run instead; it pauses when that node ends.`
    );
  }
  assertPausable(run);
  await assertOwnerAnswers(ctx, run);
  const pending = operatorPause(run);
  if (pending !== null) return { run, requested: pending.requested, alreadyRequested: true };

  const requested = { at: new Date().toISOString(), ...(await itemAct(ctx.store, actor, via)) };
  const recorded = await ctx.store.updateWorkflowRunMetadataIfRunning(run.id, {
    [OPERATOR_PAUSE_METADATA_KEY]: { requested },
  });
  if (!recorded) {
    const latest = await ctx.getRunOrThrow(run.id, 'operations.workflow_pause_lookup_failed');
    assertPausable(latest);
    throw new Error(`Run ${run.id} changed while its pause was being recorded; try again.`);
  }
  return { run, requested, alreadyRequested: false };
}

function assertPausable(run: WorkflowRun): void {
  if (run.status === 'running') return;
  const paused = run.status === 'paused' ? operatorPause(run) : null;
  const reason =
    paused !== null
      ? `it is already paused by an operator since ${paused.pausedAt ?? paused.requested.at}. ` +
        `Resume it with 'archon workflow resume ${run.id}'.`
      : run.status === 'paused'
        ? 'it is paused at a gate, a wait or a sub-run, not running. Answer it or let it continue first.'
        : run.status === 'pending'
          ? 'it has not started.'
          : `it is ${run.status}. Only a running run can be paused.`;
  throw new PauseRefusedError('not_running', `Cannot pause run ${run.id}: ${reason}`);
}

/**
 * A pause is honoured only by the executor that owns the run, so it is recorded only
 * while that owner answers. Ownership is never guessed: a run whose owner is gone, or
 * cannot be asked from here, is refused unchanged.
 */
async function assertOwnerAnswers(ctx: OperationContext, run: WorkflowRun): Promise<void> {
  if (ctx.isRunOwnedByThisProcess(run.id) || (await ctx.isRunOwnerAnswering(run.id))) return;
  const recorded = readExecutionOwner(run.metadata);
  const where = unreachableOwner(recorded);
  if (where !== undefined) {
    throw new PauseRefusedError(
      'owner_unreachable',
      `Run ${run.id} is running and its recorded owner runs ${where}. ` +
        `Its owner cannot be asked from here, so run ${run.id} was not changed. Pause it from that host and user.`
    );
  }
  const ownerName = recorded
    ? `host ${recorded.host}, pid ${String(recorded.pid)}`
    : 'none recorded';
  throw new PauseRefusedError(
    'no_owner_answered',
    `No live owner answered for run ${run.id} on this host (recorded owner: ${ownerName}). ` +
      `No executor would reach a node boundary, so run ${run.id} was not changed. ` +
      `If its process is gone, resume it with 'archon workflow resume ${run.id}' ` +
      `or abandon it with 'archon workflow abandon ${run.id}'.`
  );
}
