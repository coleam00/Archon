import type { AttentionLabels } from '../schemas/wait-node';
import type { RecordSurface } from '../schemas/record-surface';
import {
  attentionLabels,
  attentionRevision,
  pausedAttentionWait,
  workflowWaitStepName,
  type WorkflowAttentionWaitContext,
  type WorkflowRun,
} from '../schemas/workflow-run';
import type { ObservabilityEventInput } from './event-types';

/**
 * The audit row for an attention wait's answer, written in the answer's transaction by
 * every store. `wait` is the answered wait as stored.
 */
export function waitAnsweredEvent(
  workflowRunId: string,
  wait: WorkflowAttentionWaitContext
): ObservabilityEventInput {
  return {
    workflow_run_id: workflowRunId,
    event_type: 'wait_answered',
    step_name: workflowWaitStepName(wait),
    data: { via: wait.answeredVia, occurrence: wait.pauseId, answer: wait.answer },
  };
}

/** One answer to an open attention wait, checked against the occurrence it names. */
export type AttentionAnswerWrite = Required<
  Pick<WorkflowAttentionWaitContext, 'pauseId' | 'answer' | 'answeredVia' | 'answeredAt'>
>;

/**
 * The wait `run` sits at once `write` lands: the stored wait, labels and revision
 * included, with the answer added. `undefined` when the run is no longer paused at
 * that unanswered occurrence.
 */
export function answeredAttentionWait(
  run: Pick<WorkflowRun, 'status' | 'metadata'>,
  write: AttentionAnswerWrite
): WorkflowAttentionWaitContext | undefined {
  const wait = pausedAttentionWait(run);
  if (wait === undefined || wait.answer !== undefined || wait.pauseId !== write.pauseId)
    return undefined;
  return { ...wait, ...write };
}

/** One label write on an open attention wait, checked against the occurrence it names. */
export interface AttentionLabelWrite {
  /** The `pauseId` of the wait the writer read; a write for any other pause is refused. */
  pauseId: string;
  set: Readonly<AttentionLabels>;
  unset: readonly string[];
  via: RecordSurface;
}

/**
 * The wait `run` sits at once `write` lands: its labels with the set keys replaced and
 * the unset keys removed, one revision on. Undefined when the write cannot land because
 * the run is not paused at that unanswered attention wait. Every store applies this
 * inside its write transaction, so the merge and the occurrence check are one rule.
 */
export function labeledAttentionWait(
  run: Pick<WorkflowRun, 'status' | 'metadata'>,
  write: AttentionLabelWrite
): WorkflowAttentionWaitContext | undefined {
  const wait = pausedAttentionWait(run);
  if (wait === undefined || wait.answer !== undefined || wait.pauseId !== write.pauseId)
    return undefined;
  const merged = { ...attentionLabels(wait), ...write.set };
  const labels = Object.fromEntries(
    Object.entries(merged).filter(([key]) => !write.unset.includes(key))
  );
  return { ...wait, labels, revision: attentionRevision(wait) + 1 };
}

/**
 * The audit row for a label write, written in the write's transaction by every store.
 * `wait` is the wait as `labeledAttentionWait` left it.
 */
export function attentionLabeledEvent(
  workflowRunId: string,
  wait: WorkflowAttentionWaitContext,
  write: AttentionLabelWrite
): ObservabilityEventInput {
  return {
    workflow_run_id: workflowRunId,
    event_type: 'attention_labeled',
    step_name: workflowWaitStepName(wait),
    data: {
      via: write.via,
      occurrence: write.pauseId,
      set: write.set,
      unset: write.unset,
      revision: attentionRevision(wait),
    },
  };
}
