import {
  attentionLabelKeySchema,
  attentionLabelsSchema,
  type AttentionLabels,
} from '@archon/workflows/schemas/dag-node';
import type { RecordSurface } from '@archon/workflows/schemas/record-surface';
import {
  attentionLabels,
  attentionRevision,
  pausedAttentionWait,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { RunActor } from '../run-authorization';
import type { OperationContext } from './context';
import {
  assertAnswerAdmissible,
  expectedGateForOccurrence,
  lostGateError,
} from './answer-admission';

/** A label write on an attention wait: the occurrence it is for, keys to set and keys to remove. */
export interface AttentionLabelRequest {
  occurrence: string;
  set: Readonly<AttentionLabels>;
  unset: readonly string[];
}

/** An attention wait's labels after a write, and the revision that write produced. */
export interface AttentionLabelResult {
  runId: string;
  occurrence: string;
  revision: number;
  labels: AttentionLabels;
}

/**
 * The occurrence of the open attention wait a label write lands on, refusing every
 * state where it cannot: a malformed write, a stale occurrence (named first, like an
 * answer's), a gate, a blocked parent, or a wait already answered. Only `wait: attention`
 * pauses carry labels. Read-only, so a surface can check before it writes.
 */
export function assertLabelable(
  run: WorkflowRun,
  request: AttentionLabelRequest,
  via: RecordSurface
): string {
  attentionLabelsSchema.parse(request.set);
  for (const key of request.unset) attentionLabelKeySchema.parse(key);
  if (Object.keys(request.set).length === 0 && request.unset.length === 0)
    throw new Error('A label write needs at least one key to set or unset.');
  const both = request.unset.find(key => Object.hasOwn(request.set, key));
  if (both !== undefined) throw new Error(`Label '${both}' is both set and unset.`);
  assertAnswerAdmissible(run, {
    via,
    expectedGate: expectedGateForOccurrence(run, request.occurrence),
  });
  const wait = pausedAttentionWait(run);
  if (wait === undefined) {
    const attention = runAttention(run);
    if (attention?.kind === 'blocked_on_child' || attention?.kind === 'blocked_on_children') {
      const children =
        attention.kind === 'blocked_on_child' ? [attention.childRunId] : attention.childRunIds;
      throw new Error(
        `Run ${run.id} is paused waiting on sub-run ${children.join(', ')}. Label the sub-run's item instead.`
      );
    }
    throw new Error(
      attention?.kind === 'awaiting_response'
        ? `Run ${run.id} is paused at a gate. Only attention waits carry labels.`
        : `Run ${run.id} is not paused at an attention wait (status '${run.status}').`
    );
  }
  if (wait.answer !== undefined)
    throw new Error(
      `Run ${run.id}'s attention wait was already answered and is awaiting continuation.`
    );
  if (wait.pauseId === undefined)
    throw new Error(
      `Run ${run.id} paused at an attention wait before pause identities existed; it takes no labels.`
    );
  return wait.pauseId;
}

/**
 * Merge a label write into the attention wait `runId` is paused at. Who may write is
 * the same as who may answer. The store checks the occurrence again as it commits, so
 * a write that loses a race with an answer or a new pause is refused the same way.
 */
export async function labelAttentionWait(
  ctx: OperationContext,
  runId: string,
  request: AttentionLabelRequest,
  actor: RunActor,
  via: RecordSurface
): Promise<AttentionLabelResult> {
  const run = await ctx.getRunOrThrow(runId, 'operations.workflow_label_lookup_failed');
  await ctx.assertMayAct(run, actor, 'respond');
  const occurrence = assertLabelable(run, request, via);
  const result = await ctx.store.labelAttentionWait(run.id, {
    pauseId: occurrence,
    set: request.set,
    unset: request.unset,
    via,
  });
  if (!result.labeled)
    throw await lostGateError(ctx, run.id, expectedGateForOccurrence(run, occurrence));
  return {
    runId: run.id,
    occurrence,
    revision: attentionRevision(result.wait),
    labels: attentionLabels(result.wait),
  };
}
