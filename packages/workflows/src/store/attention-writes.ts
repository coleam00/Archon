import { z } from 'zod';
import {
  attentionFormSchema,
  attentionRecommendationSchema,
  type AttentionLabels,
} from '../schemas/wait-node';
import type { RecordSurface } from '../schemas/record-surface';
import {
  attentionAnswererSchema,
  attentionAnsweringRunSchema,
  attentionAnswerSchema,
  attentionForm,
  attentionLabels,
  attentionOptions,
  attentionRevision,
  pausedAttentionWait,
  workflowWaitStepName,
  type AttentionAnsweringRun,
  type WorkflowAttentionWaitContext,
  type WorkflowRun,
} from '../schemas/workflow-run';
import type { ObservabilityEventInput } from './event-types';

/**
 * What an attention wait's `wait_started` row records about the ask, beside its labels:
 * the occurrence, the form, the option ids offered and the recommended one. It is what
 * measures whether recommendations are followed once the wait's context is gone. Ids
 * only: never the message, an option's label or the recommendation's `why`.
 */
export const attentionAskRecordSchema = z.object({
  occurrence: z.string(),
  form: attentionFormSchema,
  options: z.array(z.string()),
  /** The last of `options` is the reserved one, whose answer carries its own text. */
  other: z.literal(true).optional(),
  recommendation: attentionRecommendationSchema.pick({ option: true, confidence: true }).optional(),
});
export type AttentionAskRecord = z.infer<typeof attentionAskRecordSchema>;

/** The ask record of a wait as it pauses; undefined for a wait from before occurrences. */
export function attentionAskRecord(
  wait: WorkflowAttentionWaitContext
): AttentionAskRecord | undefined {
  if (wait.pauseId === undefined) return undefined;
  const { recommendation } = wait;
  return {
    occurrence: wait.pauseId,
    form: attentionForm(wait),
    options: attentionOptions(wait).map(option => option.id),
    ...(wait.other === true ? { other: true } : {}),
    ...(recommendation === undefined
      ? {}
      : {
          recommendation: {
            option: recommendation.option,
            ...(recommendation.confidence === undefined
              ? {}
              : { confidence: recommendation.confidence }),
          },
        }),
  };
}

/**
 * What a `wait_answered` row records: the surface, the occurrence, the answer, who, and
 * the run the answer was given from when it came from inside one.
 */
export const attentionAnswerRecordSchema = z.object({
  occurrence: z.string(),
  answer: attentionAnswerSchema,
  by: attentionAnswererSchema.optional(),
  fromRun: attentionAnsweringRunSchema.optional(),
});

/**
 * The audit row for an attention wait's answer, written in the answer's transaction by
 * every store. `wait` is the answered wait as stored, and `fromRun` the write's.
 */
export function waitAnsweredEvent(
  workflowRunId: string,
  wait: WorkflowAttentionWaitContext,
  fromRun: AttentionAnsweringRun | undefined
): ObservabilityEventInput {
  return {
    workflow_run_id: workflowRunId,
    event_type: 'wait_answered',
    step_name: workflowWaitStepName(wait),
    data: {
      via: wait.answeredVia,
      occurrence: wait.pauseId,
      answer: wait.answer,
      ...(wait.answeredBy === undefined ? {} : { by: wait.answeredBy }),
      ...(fromRun === undefined ? {} : { fromRun }),
    },
  };
}

/** One answer to an open attention wait, checked against the occurrence it names. */
export type AttentionAnswerWrite = Required<
  Pick<WorkflowAttentionWaitContext, 'pauseId' | 'answer' | 'answeredVia' | 'answeredAt'>
> &
  Pick<WorkflowAttentionWaitContext, 'answeredBy'> & { fromRun?: AttentionAnsweringRun };

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
  // `fromRun` goes on the event alone (`attentionAnsweringRunSchema`).
  const { fromRun: _fromRun, ...answer } = write;
  return { ...wait, ...answer };
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
