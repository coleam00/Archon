/**
 * The persisted wait a paused run sits at (`metadata.wait`): time, event, quota and
 * attention waits owned by a node or a loop_group body, and the readers that answer what
 * an attention wait accepts.
 */
import { z } from 'zod';
import {
  APPROVAL_ATTENTION_OPTIONS,
  attentionFormSchema,
  attentionLabelsSchema,
  attentionOptionSchema,
  type AttentionForm,
  type AttentionLabels,
  type AttentionOption,
} from './wait-node';
import { recordSurfaceSchema } from './record-surface';
import { readSourceRelease } from './run-metadata';
import type { WorkflowRun } from './workflow-run';

// Optional only for waits persisted before occurrence IDs were introduced.
const workflowWaitDeadlineOccurrenceFields = {
  pauseId: z.string().min(1).optional(),
};

const workflowWaitTimeFields = {
  ...workflowWaitDeadlineOccurrenceFields,
  kind: z.literal('time'),
  waitingSince: z.string().datetime(),
  resumeAt: z.string().datetime(),
} as const;
const workflowWaitEventFields = {
  ...workflowWaitDeadlineOccurrenceFields,
  kind: z.literal('event'),
  waitingSince: z.string().datetime(),
  resumeAt: z.string().datetime(),
  event: z.string().trim().min(1),
  signaledAt: z.string().datetime().optional(),
  payload: z.unknown().optional(),
} as const;
/**
 * A run whose failed nodes all hit a provider usage limit with a reported reset, or a rate
 * limit that outlasted its retries, waits until the latest of their deadlines
 * (`usageLimitWait` in the DAG executor). The resume claim clears it, and the nodes run
 * again; a repeat limit pauses on a new wait.
 */
const workflowWaitQuotaFields = {
  pauseId: z.string().min(1),
  kind: z.literal('quota'),
  waitingSince: z.string().datetime(),
  resumeAt: z.string().datetime(),
} as const;
/**
 * The answer an attention wait received, as the next node reads it. Its shape is the
 * wait's form's output contract (`ATTENTION_OUTPUT_FORMATS`).
 */
export const attentionAnswerSchema = z.union([
  z.strictObject({ text: z.string() }),
  z.strictObject({ decision: z.string().min(1), text: z.string() }),
  z.strictObject({ decisions: z.array(z.string().min(1)).min(1), text: z.string() }),
]);
export type AttentionAnswer = z.infer<typeof attentionAnswerSchema>;

/**
 * An attention wait paused before answers existed has only `waitingSince` and `message`:
 * no `pauseId`, it reads as the `message` form, and only `resume` continues it. A newer
 * wait carries its occurrence, its form and resolved options, and once answered, the
 * answer with the surface it came through and when. `labels` holds the node's resolved
 * labels merged with every label write since, and `revision` counts those writes from 1;
 * a wait without them has no labels and is at revision 1.
 */
const workflowWaitAttentionFields = {
  kind: z.literal('attention'),
  waitingSince: z.string().datetime(),
  message: z.string().trim().min(1),
  pauseId: z.string().min(1).optional(),
  form: attentionFormSchema.optional(),
  options: z.array(attentionOptionSchema).optional(),
  answer: attentionAnswerSchema.optional(),
  answeredVia: recordSurfaceSchema.optional(),
  answeredAt: z.string().datetime().optional(),
  labels: attentionLabelsSchema.optional(),
  revision: z.number().int().positive().optional(),
  loopQuestionReferences: z.record(z.string(), z.string()).optional(),
  reaskedFrom: z.string().min(1).optional(), // occurrence whose answer was discarded as stale
} as const;
const workflowWaitNodeOwnerFields = {
  owner: z.literal('node'),
  nodeId: z.string().min(1),
} as const;
export const sessionCursorSchema = z.object({
  sessionId: z.string().min(1),
  provider: z.string().min(1),
});
export type SessionCursor = z.infer<typeof sessionCursorSchema>;
export const bodySessionCursorsSchema = z.record(z.string().min(1), sessionCursorSchema);

export const bodySessionCursorAncestrySchema = z.record(
  z.string().min(1),
  bodySessionCursorsSchema
);
export type BodySessionCursorAncestry = z.infer<typeof bodySessionCursorAncestrySchema>;

const workflowWaitLoopOwnerFields = {
  owner: z.literal('loop_group'),
  nodeId: z.string().min(1),
  bodyWaitId: z.string().min(1),
  iteration: z.number().int().positive(),
  sessionId: z.string().nullable(),
  sessionProvider: z.string().nullable(),
  bodySessionCursors: bodySessionCursorsSchema.optional(),
  bodySessionCursorAncestry: bodySessionCursorAncestrySchema.optional(),
} as const;

/**
 * Persisted reason a run is waiting outside its current execution.
 * Loop-owned cursors carry their complete owner path in the initial pause write;
 * there is no externally visible body-owned intermediate state.
 */
export const workflowWaitContextSchema = z.union([
  z.strictObject({ ...workflowWaitNodeOwnerFields, ...workflowWaitTimeFields }),
  z.strictObject({ ...workflowWaitNodeOwnerFields, ...workflowWaitEventFields }),
  z.strictObject({ ...workflowWaitNodeOwnerFields, ...workflowWaitAttentionFields }),
  z.strictObject({ ...workflowWaitNodeOwnerFields, ...workflowWaitQuotaFields }),
  z.strictObject({ ...workflowWaitLoopOwnerFields, ...workflowWaitTimeFields }),
  z.strictObject({ ...workflowWaitLoopOwnerFields, ...workflowWaitEventFields }),
  z.strictObject({ ...workflowWaitLoopOwnerFields, ...workflowWaitAttentionFields }),
]);
export type WorkflowWaitContext = z.infer<typeof workflowWaitContextSchema>;
export type WorkflowAttentionWaitContext = Extract<WorkflowWaitContext, { kind: 'attention' }>;
export type WorkflowUsageLimitWaitContext = Extract<WorkflowWaitContext, { kind: 'quota' }>;

export function validateWorkflowWaitMetadata(metadata: Record<string, unknown> | undefined): void {
  if (metadata && Object.hasOwn(metadata, 'wait')) workflowWaitContextSchema.parse(metadata.wait);
}

const workflowWaitContextKeys = new Set(
  workflowWaitContextSchema.options.flatMap(branch => Object.keys(branch.shape))
);

/** Read known wait fields without relaxing the strict contract used by writers. */
export function readWorkflowWaitContext(value: unknown): WorkflowWaitContext | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  // Keep keys from every variant so known fields on the wrong kind or owner still fail.
  const known = Object.fromEntries(
    Object.entries(value).filter(([key]) => workflowWaitContextKeys.has(key))
  );
  const parsed = workflowWaitContextSchema.safeParse(known);
  return parsed.success ? parsed.data : undefined;
}

export function isWorkflowWaitContext(value: unknown): value is WorkflowWaitContext {
  return readWorkflowWaitContext(value) !== undefined;
}

export function workflowWaitStepName(wait: WorkflowWaitContext): string {
  return wait.owner === 'loop_group' ? `${wait.nodeId}.${wait.bodyWaitId}` : wait.nodeId;
}

/** The attention wait a paused run sits at, answered or not, if it sits at one. */
export function pausedAttentionWait(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): WorkflowAttentionWaitContext | undefined {
  if (run.status !== 'paused' || readSourceRelease(run.metadata)) return undefined;
  const wait = readWorkflowWaitContext(run.metadata.wait);
  return wait?.kind === 'attention' ? wait : undefined;
}

/** The usage-limit wait a paused run sits at, if it sits at one. */
export function pausedUsageLimitWait(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): WorkflowUsageLimitWaitContext | undefined {
  if (run.status !== 'paused' || readSourceRelease(run.metadata)) return undefined;
  const wait = readWorkflowWaitContext(run.metadata.wait);
  return wait?.kind === 'quota' ? wait : undefined;
}

/** The form and literal options an attention wait declares, paused or authored. */
type AttentionDeclaration = { form?: AttentionForm; options?: readonly AttentionOption[] };

/** The form an attention wait is answered in; a wait from before forms is a message. */
export function attentionForm(wait: AttentionDeclaration): AttentionForm {
  return wait.form ?? 'message';
}

/** The ids an attention wait's answer may choose from: none for a message. */
export function attentionOptions(wait: AttentionDeclaration): readonly AttentionOption[] {
  switch (attentionForm(wait)) {
    case 'message':
      return [];
    case 'approval':
      return APPROVAL_ATTENTION_OPTIONS;
    case 'select':
    case 'multi_select':
      return wait.options ?? [];
  }
}

/**
 * Why choosing `choose` does not answer a wait in `form` that declares the option ids
 * `declared`, or undefined when it does: a message takes only text; approval and select
 * take exactly one declared option; multi_select takes one or more distinct declared
 * options. Every answer surface, and a dry run's authored answer, holds this one rule.
 */
export function attentionChoiceProblem(
  form: AttentionForm,
  declared: readonly string[],
  choose: readonly string[]
): string | undefined {
  if (form === 'message') return choose.length > 0 ? 'takes only text, not an option.' : undefined;
  const undeclared = choose.filter(id => !declared.includes(id));
  if (undeclared.length > 0)
    return `does not declare option '${undeclared.join("', '")}'. Declared options: ${declared.join(', ')}.`;
  if (form === 'multi_select') {
    if (choose.length === 0) return 'needs at least one option.';
    if (new Set(choose).size !== choose.length) return 'takes each option at most once.';
    return undefined;
  }
  return choose.length === 1
    ? undefined
    : `takes exactly one option. Declared options: ${declared.join(', ')}.`;
}

/** An attention wait's current labels. */
export function attentionLabels(wait: WorkflowAttentionWaitContext): AttentionLabels {
  return wait.labels ?? {};
}

/** How many label writes an attention wait has seen, counting from 1. */
export function attentionRevision(wait: WorkflowAttentionWaitContext): number {
  return wait.revision ?? 1;
}

export const scheduledWorkflowResumeSchema = z
  .object({
    reason: z.literal('quota'),
    resumeAt: z.string().datetime(),
    deadlineAt: z.string().datetime(),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    triggeredAt: z.string().datetime().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.attempt > value.maxAttempts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempt'],
        message: 'quota continuation attempt cannot exceed maxAttempts',
      });
    }
    if (Date.parse(value.resumeAt) > Date.parse(value.deadlineAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resumeAt'],
        message: 'quota continuation resumeAt cannot exceed deadlineAt',
      });
    }
  });
export type ScheduledWorkflowResume = z.infer<typeof scheduledWorkflowResumeSchema>;

export function isScheduledWorkflowResume(value: unknown): value is ScheduledWorkflowResume {
  return scheduledWorkflowResumeSchema.safeParse(value).success;
}

export type WorkflowDeadlineWaitContext = Extract<WorkflowWaitContext, { resumeAt: string }>;

/** The validated deadline-bearing wait for a paused run, if it has one. */
export function pendingWorkflowWaitDeadline(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): WorkflowDeadlineWaitContext | undefined {
  if (run.status !== 'paused' || readSourceRelease(run.metadata)) return undefined;
  const wait = readWorkflowWaitContext(run.metadata.wait);
  if (!wait || wait.kind === 'attention') return undefined;
  return wait;
}

/**
 * Whether a deadline-bearing wait is ready to continue: its deadline passed, or its event
 * was signaled (a signal leaves `resumeAt` in the future). The SQL continuation listing
 * restates this; the store conformance suite pins the two together.
 */
export function workflowWaitDue(wait: WorkflowDeadlineWaitContext, now: number): boolean {
  return (
    Date.parse(wait.resumeAt) <= now || (wait.kind === 'event' && wait.signaledAt !== undefined)
  );
}
