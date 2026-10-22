/**
 * Zod schemas for workflow run state types.
 */
import {
  declaredOutputPathsSchema,
  outputPathsFromRootFields,
  type DeclaredOutputPaths,
} from '../output-ref';
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
import { approvalDecisionConfigSchema } from './gate-node';
import { skipCauseSchema, suspendReasonSchema, type NodeState } from './node-state';
import { tokenUsageSchema } from '@archon/provider-contract';
import { providerFailureSchema } from '@archon/provider-contract';
import { nodeExecutionMetadataSchema, nodeFailureKindSchema } from './node-execution';
import { checkoutObservationSchema } from './checkout-observation';
import { recordSurfaceSchema } from './record-surface';
import { runStopReasonSchema, type RunStopReason } from './run-terminal-reason';
import { workflowSourceSchema } from './workflow';
// Type-only, so the output-ref ↔ schemas edge stays erased (no runtime cycle).
import type { JsonValue } from '../output-ref';
import { isAbsolute } from 'path';

// ---------------------------------------------------------------------------
// WorkflowRunStatus
// ---------------------------------------------------------------------------

/**
 * `'paused'` is treated as a still-live status for in-flight sibling node streaming:
 * a concurrent gate pausing the run must not tear down an unrelated node's
 * already-streaming output in the same topological layer. See
 * `shouldContinueStreamingForStatus` in dag/run-control.ts, which encodes this policy.
 */
export const workflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
]);

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

// ---------------------------------------------------------------------------
// WorkflowRunOutcome
// ---------------------------------------------------------------------------

/**
 * Workflow-authored verdict, independent from engine-owned lifecycle status.
 * Null on a run means no declared result has been authored yet (or the
 * workflow does not declare one); it never means failure.
 */
export const workflowRunOutcomeSchema = z.enum(['succeeded', 'failed']);

export type WorkflowRunOutcome = z.infer<typeof workflowRunOutcomeSchema>;

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

const LEGACY_OCCURRENCE_PREFIX = 'legacy:';

/**
 * The step a `legacy:<step>` occurrence names, or undefined for a pause id. A legacy
 * occurrence identifies a pause from before pause identities existed.
 */
export function legacyOccurrenceStep(occurrence: string): string | undefined {
  return occurrence.startsWith(LEGACY_OCCURRENCE_PREFIX)
    ? occurrence.slice(LEGACY_OCCURRENCE_PREFIX.length)
    : undefined;
}

/**
 * The occurrence id of an attention wait, by the same rule as `gateOccurrence`: its
 * `pauseId`, or `legacy:<step>` for a wait paused before pause identities existed.
 */
export function attentionOccurrence(wait: WorkflowAttentionWaitContext): string {
  return wait.pauseId ?? `${LEGACY_OCCURRENCE_PREFIX}${workflowWaitStepName(wait)}`;
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

/**
 * The narrow tuple behind `TERMINAL_WORKFLOW_STATUSES`. It exists only so
 * `RunTerminalStatus` can be derived from the same list the runtime checks
 * against — the exported constant keeps its widened element type because
 * callers pass an arbitrary `WorkflowRunStatus` to `.includes()`.
 */
const TERMINAL_STATUS_TUPLE = ['completed', 'failed', 'cancelled'] as const;
export const terminalWorkflowRunStatusSchema =
  workflowRunStatusSchema.extract(TERMINAL_STATUS_TUPLE);

/** Statuses that indicate a run has finished and cannot transition further. */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = TERMINAL_STATUS_TUPLE;

/** A finished run's status — the narrow half of `TERMINAL_WORKFLOW_STATUSES`. */
export type RunTerminalStatus = (typeof TERMINAL_STATUS_TUPLE)[number];

/** Persisted terminal event names; every terminal status must have one. */
export const TERMINAL_RUN_EVENT_TYPE = {
  completed: 'workflow_completed',
  failed: 'workflow_failed',
  cancelled: 'workflow_cancelled',
} as const satisfies { [Status in RunTerminalStatus]: `workflow_${Status}` };

export const TERMINAL_RUN_EVENT_TYPES: readonly (typeof TERMINAL_RUN_EVENT_TYPE)[RunTerminalStatus][] =
  Object.values(TERMINAL_RUN_EVENT_TYPE);

export function terminalRunStatusForEventType(eventType: string): RunTerminalStatus | undefined {
  return TERMINAL_STATUS_TUPLE.find(status => TERMINAL_RUN_EVENT_TYPE[status] === eventType);
}

/** Narrowing membership test for `TERMINAL_WORKFLOW_STATUSES`. */
export function isTerminalRunStatus(status: WorkflowRunStatus): status is RunTerminalStatus {
  return TERMINAL_STATUS_TUPLE.some(terminal => terminal === status);
}

/** Cancellation leaves these statuses untouched; failed runs remain cancellable because they can resume. */
export const CANCELLATION_NOOP_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] =
  workflowRunStatusSchema.extract(['completed', 'cancelled']).options;

/** Statuses that allow a user to resume execution. */
export const RESUMABLE_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = [
  'failed',
  'paused',
] as const;

// ---------------------------------------------------------------------------
// WorkflowStepStatus
// ---------------------------------------------------------------------------

export const workflowStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;

// ---------------------------------------------------------------------------
// NodeState
// ---------------------------------------------------------------------------

export { nodeStateSchema, skipCauseSchema, nodeSkipReasonSchema } from './node-state';
export type { NodeState, SkipCause, NodeSkipReason } from './node-state';

/**
 * Captured output from a completed DAG node.
 * `output` is the concatenated assistant text (or JSON-encoded string from the SDK
 * when output_format is set). Empty string for a skipped/pending node; for a FAILED
 * node it is usually empty too, but not always — a `loop_group`'s failure paths
 * (body-node failure, `max_iterations` exhaustion, cancellation) deliberately carry
 * the last completed iteration's real, non-empty output. No reader of a 'failed'
 * node's `output` may treat it as trustworthy regardless of content (#2713).
 * `error` is required when state is 'failed', absent on all other states.
 * `cause` is required when state is 'skipped' so downstream decisions retain its provenance.
 * `structuredOutput` carries the provider's parsed structured payload (set by Pi/Codex/Claude
 * when the result chunk includes one). Downstream `$nodeId.output.field` substitution and
 * `when:` conditions prefer this object over re-parsing `output`, so providers that emit
 * fence-wrapped or preamble-prefixed JSON (Pi/Minimax) survive the round-trip.
 * `declaredOutputPaths` is every object-field path a producer's `output_format` schema
 * declares, captured when the node completes. The consumer uses it to tell a
 * declared-but-optional-absent field (resolves to `''`) from a path not in the contract
 * at all (a typo → throws). Undefined for non-schema producers (bash/script/prose) and
 * schemas without a `properties` map.
 */
export const nodeOutputSchema = z.discriminatedUnion('state', [
  z.object({
    execution: nodeExecutionMetadataSchema.optional(),
    state: z.enum(['completed', 'running']),
    output: z.string(),
    sessionId: z.string().optional(),
    structuredOutput: z.unknown().optional(),
    declaredOutputPaths: declaredOutputPathsSchema.optional(),
    /** Session-resume outcome from the provider: false ⇒ a requested resume came
     *  back cold (fresh session). Drives the executor's cold-resume warning.
     *  Absent on 'failed' nodes — the retry path, not this signal, handles those. */
    resumed: z.boolean().optional(),
  }),
  z.object({
    execution: nodeExecutionMetadataSchema.optional(),
    state: z.literal('failed'),
    output: z.string(),
    sessionId: z.string().optional(),
    error: z.string(),
    structuredOutput: z.unknown().optional(),
    declaredOutputPaths: declaredOutputPathsSchema.optional(),
    /** Set by a producer whose failure is a deterministic diagnosis of its own output
     *  (an exec node's stdout missing its declared `output_format`): re-running yields
     *  the same stdout, so the retry loop must not consult the error text, which quotes
     *  that stdout and can read as transient. Only `false` is expressible: a producer can
     *  refuse retry, never force one past a FATAL classification. */
    retryable: z.literal(false).optional(),
    /** Why the node failed, when the producer knows it (see `nodeFailureKindSchema`). */
    failureKind: nodeFailureKindSchema.optional(),
    /** The provider's own typed failure, unchanged, when a provider reported one. */
    providerFailure: providerFailureSchema.optional(),
  }),
  z.object({
    execution: nodeExecutionMetadataSchema.optional(),
    state: z.literal('pending'),
    output: z.string(),
  }),
  z.object({
    execution: nodeExecutionMetadataSchema.optional(),
    state: z.literal('skipped'),
    output: z.string(),
    cause: skipCauseSchema,
  }),
]);

export type NodeOutput = z.infer<typeof nodeOutputSchema>;

// ---------------------------------------------------------------------------
// WorkflowRun
// ---------------------------------------------------------------------------

export const workflowRunOriginSchema = z
  .object({
    conversationId: z.string().optional(),
    parentConversationId: z.string().optional(),
    userId: z.string().optional(),
  })
  .strict();

export type WorkflowRunOrigin = z.infer<typeof workflowRunOriginSchema>;

export const workflowRunSchema = z.object({
  origin: workflowRunOriginSchema.nullable(),
  id: z.string(),
  workflow_name: z.string(),
  conversation_id: z.string().nullable(),
  parent_conversation_id: z.string().nullable(),
  codebase_id: z.string().nullable(),
  status: workflowRunStatusSchema,
  outcome: workflowRunOutcomeSchema.nullable(),
  user_message: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  started_at: z.date(),
  completed_at: z.date().nullable(),
  last_activity_at: z.date().nullable(),
  working_path: z.string().nullable(),
  user_id: z.string().nullable(),
  /**
   * Run-tree parent (#2121 Phase 2). Set when this run is a `workflow:` sub-run
   * spawned as one node of a parent run; null for top-level runs. Self-referential
   * FK with ON DELETE SET NULL (a deleted parent orphans, never cascades). Paired
   * with `metadata.parent_node_id` so the parent can re-find WHICH node's child on
   * resume.
   */
  parent_run_id: z.string().nullable(),
  /**
   * Between-run continuation (#2747). The terminal run whose estate (branch/
   * worktree + artifacts-by-reference via `$ADOPTED_RUN_DIR`) this run
   * explicitly adopted. Written once at run creation, never on resume (the
   * `output_root` write-once precedent). Reverse lookup (`adopted_by`) reads
   * the same column — the chain walks in both directions with no second
   * column. Also carries supersession (`--supersedes`), which records
   * provenance WITHOUT lane inheritance; the mode lives in run metadata.
   */
  adopted_from_run_id: z.string().nullable(),
  /**
   * Durable pointer to this run's storage tree (#2200) — the resolved
   * `~/.archon/workspaces/<project>/` root its artifacts, logs, and state live
   * under. Written ONCE at run start and never rewritten (a resume must not
   * re-derive it). Readers prefer it and only fall back to deriving identity
   * from the codebase row when it is null, which is what keeps historical
   * artifacts addressable across a codebase rename (#1192). Null on rows
   * created before the column existed.
   */
  output_root: z.string().nullable(),
  /**
   * The checkout this run started from (#3305): observed once, immediately after the run
   * won its execution claim and before its first node, then never rewritten. A resume
   * keeps it. Null means not recorded — a run from before this column, or one that never
   * started — which is different from a recorded `not_git` or `unavailable` observation.
   */
  checkout_baseline: checkoutObservationSchema.nullable(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

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

/** The identity a continuation host claims an answered pause by. */
export interface PauseContinuation {
  nodeId: string;
  pauseId: string;
}

/**
 * The answerable pause a paused run sits at, if the continuation host continues it once
 * it is answered: a gate, or an attention wait. `answered` says whether that has
 * happened. This is the one place that decides which answerable pauses the engine
 * continues by itself.
 *
 * Excluded: a parent blocked on a child (it continues through the child), a container
 * write-back (only a CLI holding the container can apply it), any container run (the
 * host cannot resume one), and a gate or attention wait from before `pauseId` existed
 * (no identity to claim against). A gate beside a `wait:` is a leftover the wait
 * replaced; that also covers file-store rows written before a wait pause began removing
 * the previous gate's answer. Time and event waits continue on their deadline instead
 * (`pendingWorkflowWaitDeadline`).
 */
export function continuablePause(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): (PauseContinuation & { answered: boolean }) | undefined {
  if (run.status !== 'paused' || isContainerRun(run) || readSourceRelease(run.metadata))
    return undefined;
  const wait = run.metadata.wait;
  if (wait !== undefined) {
    if (!isWorkflowWaitContext(wait) || wait.kind !== 'attention' || wait.pauseId === undefined)
      return undefined;
    return { nodeId: wait.nodeId, pauseId: wait.pauseId, answered: wait.answer !== undefined };
  }
  const approval = run.metadata.approval;
  if (!isApprovalContext(approval)) return undefined;
  if (
    approval.type === 'child_workflow' ||
    approval.type === 'fan_out' ||
    approval.type === 'writeback'
  )
    return undefined;
  if (approval.pauseId === undefined || approval.nodeId === '') return undefined;
  return { nodeId: approval.nodeId, pauseId: approval.pauseId, answered: isGateResolved(approval) };
}

/**
 * The answered pause a paused run is waiting to be continued past, if it has one.
 * Answering only records the answer; continuing is the continuation host's job, so an
 * answer given through any surface moves the run on.
 */
export function answeredPauseContinuation(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): PauseContinuation | undefined {
  const pause = continuablePause(run);
  return pause?.answered === true ? { nodeId: pause.nodeId, pauseId: pause.pauseId } : undefined;
}

/**
 * Keys the sub-run machinery writes into a child run's untyped `metadata` JSONB, and the
 * shape of each value. `metadata` is `Record<string, unknown>`, so a typo in a string
 * literal at either end silently no-ops — the write lands under a key nobody reads, or the
 * read returns undefined and the child looks like it was never stamped. Naming them once
 * gives the compiler the only handle it can have on an untyped column: writer and reader
 * now share a symbol instead of agreeing by luck.
 *
 * `parent_node_id` — which node of the parent spawned this child (both 1:1 and fan-out).
 * `child_index`    — the fan-out instance's position in the item list; ABSENT on a 1:1
 *                    child, which is what distinguishes the two on re-entry.
 * `fan_out_item_hash` — hash of the item the child was spawned with, so a resume can warn
 *                    when a non-deterministic producer changed it under the same index.
 * `inputs`         — the resolved `with:` map as canonical TEXT (name → string), persisted
 *                    at spawn so the child's `$INPUTS.<name>` reconstitutes on a cold
 *                    resume without re-resolving parent refs that may be out of scope
 *                    (#2470). Kept string-valued forever: shipped binaries read a
 *                    non-string map as corrupt/unset, so widening it in place would make
 *                    an older binary resuming a newer run lose ALL inputs.
 * `inputs_values`  — additive sibling of `inputs` (#2637): the same map with its LOGICAL
 *                    JSON values, written only when any value is non-string. Readers
 *                    prefer it; its absence degrades to the text map — exactly the old
 *                    behavior, which is what keeps old rows and old binaries correct.
 * `summary_value`  — additive sibling of `summary` (#2637): the child's terminal
 *                    structured value, stamped at completion alongside the text summary
 *                    so a parent `workflow:` node threads the logical value back.
 * `summary_declared_output_paths` — additive sibling of `summary_value`: the field
 *                    paths the child's selected `returns:` node declared, so a parent
 *                    reads `$<node>.output.a.b` under the CHILD's contract — a
 *                    `workflow:` node cannot declare a schema of its own. Only the
 *                    derived projection travels; the schema itself stays in captured
 *                    workflow source. Absent on schemaless children.
 * `summary_declared_fields` — the top-level fields of the same contract (#2453), still
 *                    written for older binaries. A row that has only this key reads as
 *                    a depth-1 path contract.
 */
export const SUBRUN_METADATA_KEYS = {
  parentNodeId: 'parent_node_id',
  childIndex: 'child_index',
  fanOutItemHash: 'fan_out_item_hash',
  inputs: 'inputs',
  inputsValues: 'inputs_values',
  summaryValue: 'summary_value',
  summaryDeclaredFields: 'summary_declared_fields',
  summaryDeclaredOutputPaths: 'summary_declared_output_paths',
} as const;

/** Typed view of the sub-run keys on a run's metadata; each is undefined when unset. */
export function readSubrunMetadata(metadata: Record<string, unknown> | undefined): {
  parentNodeId: string | undefined;
  childIndex: number | undefined;
  fanOutItemHash: string | undefined;
  inputs: Record<string, JsonValue> | undefined;
  summaryValue: unknown;
  summaryDeclaredOutputPaths: DeclaredOutputPaths | undefined;
} {
  const parentNodeId = metadata?.[SUBRUN_METADATA_KEYS.parentNodeId];
  const childIndex = metadata?.[SUBRUN_METADATA_KEYS.childIndex];
  const fanOutItemHash = metadata?.[SUBRUN_METADATA_KEYS.fanOutItemHash];
  const asPlainObject = (raw: unknown): Record<string, unknown> | undefined =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  // Prefer the logical map (#2637); fall back to the legacy text map, accepting only a
  // plain object of string values there — the legacy writer always stored strings, so a
  // non-conforming value is corrupt/foreign metadata, not a shape to coerce.
  // Metadata is DB-round-tripped JSON, so a plain object here can only hold JSON
  // values — the casts assert what the storage layer already guarantees.
  const rawValues = asPlainObject(metadata?.[SUBRUN_METADATA_KEYS.inputsValues]) as
    | Record<string, JsonValue>
    | undefined;
  const rawLegacy = asPlainObject(metadata?.[SUBRUN_METADATA_KEYS.inputs]);
  const legacyInputs =
    rawLegacy !== undefined && Object.values(rawLegacy).every(v => typeof v === 'string')
      ? (rawLegacy as Record<string, string>)
      : undefined;
  // A path contract this binary wrote must parse; a malformed one fails rather than
  // authorizing nothing. A legacy field projection is only usable as a contract when it
  // is exactly an array of strings; anything else degrades to "no contract".
  const rawDeclaredFields = metadata?.[SUBRUN_METADATA_KEYS.summaryDeclaredFields];
  const summaryDeclaredOutputPaths =
    metadata && Object.hasOwn(metadata, SUBRUN_METADATA_KEYS.summaryDeclaredOutputPaths)
      ? declaredOutputPathsSchema.parse(metadata[SUBRUN_METADATA_KEYS.summaryDeclaredOutputPaths])
      : Array.isArray(rawDeclaredFields) && rawDeclaredFields.every(f => typeof f === 'string')
        ? outputPathsFromRootFields(rawDeclaredFields)
        : undefined;
  return {
    parentNodeId: typeof parentNodeId === 'string' ? parentNodeId : undefined,
    childIndex: typeof childIndex === 'number' ? childIndex : undefined,
    fanOutItemHash: typeof fanOutItemHash === 'string' ? fanOutItemHash : undefined,
    inputs: rawValues ?? legacyInputs,
    // Presence-keyed rather than truthiness: `false`/`0`/`null` are legitimate values.
    summaryValue:
      metadata !== undefined && Object.hasOwn(metadata, SUBRUN_METADATA_KEYS.summaryValue)
        ? metadata[SUBRUN_METADATA_KEYS.summaryValue]
        : undefined,
    summaryDeclaredOutputPaths,
  };
}

/**
 * Keys the run-lifecycle machinery writes into a row's untyped `metadata` JSONB, and the
 * shape of each value. `metadata` is `Record<string, unknown>`, so a typo in a string
 * literal at either end silently no-ops — the write lands under a key nobody reads, or the
 * read returns undefined and the row looks like it was never stamped. Naming them once
 * gives the compiler the only handle it can have on an untyped column: writer and reader
 * now share a symbol instead of agreeing by luck.
 *
 * `identity_unresolved` — TRUE on a fresh run whose `output_root` was deliberately NOT
 *                       written because `resolveProjectPaths` returned the `@cwd/<basename>-<digest>`
 *                       fallback AFTER `getCodebase` threw on both retry attempts (#2304).
 *                       Distinguishes "this run is on the cwd fallback because the codebase
 *                       had no owner/repo or `_local` identity" (legitimate, the WARN arm
 *                       of the same function) from "this run is on the cwd fallback
 *                       because we couldn't reach the registry at all" (the ERROR arm).
 *                       Absent on every other run — the existing `output_root` write-once
 *                       invariant is preserved for them. Cleared by the same persistence
 *                       block the moment a later resume writes a real root, so a row that
 *                       heals stops reading as faulted.
 */
export const RUN_METADATA_KEYS = {
  identityUnresolved: 'identity_unresolved',
} as const;

/**
 * Between-run continuation (#2747). Written once at run creation alongside
 * `adopted_from_run_id`: `{mode: 'adopt'}` when this run took over a terminal
 * run's estate, `{mode: 'supersede'}` when a fresh-lane rerun replaces its open
 * item (NO lane inheritance). Lives in metadata, not a column — nothing queries
 * it except display.
 */
export const CONTINUATION_METADATA_KEY = 'continuation';

export type ContinuationMode = 'adopt' | 'supersede';

/** Typed view of the continuation stamp; undefined when the run adopted nothing. */
export function readContinuationMode(
  metadata: Record<string, unknown> | undefined
): ContinuationMode | undefined {
  const raw = metadata?.[CONTINUATION_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const mode = (raw as { mode?: unknown }).mode;
  return mode === 'adopt' || mode === 'supersede' ? mode : undefined;
}

/**
 * The host, process and user that last took over executing this run, stamped by the
 * executor each time it starts or resumes execution. The live-owner endpoint is
 * local to one host and one user, so when no owner answers, this record is what
 * `abandon` shows the operator, including whether the owner ran on another host or
 * as another user. It is a report, never a liveness signal: nothing decides a run is
 * dead from it. `workflow wait` reads its host and uid only to refuse reporting owner
 * loss when this host and user could not reach that owner's endpoint.
 */
export const EXECUTION_OWNER_METADATA_KEY = 'execution_owner';

export interface ExecutionOwnerRecord {
  host: string;
  pid: number;
  /** POSIX user id; absent on Windows, where the endpoint is not scoped by uid. */
  uid?: number;
}

/** Typed view of the execution-owner stamp; undefined on runs that predate it. */
export function readExecutionOwner(
  metadata: Record<string, unknown> | undefined
): ExecutionOwnerRecord | undefined {
  const raw = metadata?.[EXECUTION_OWNER_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { host, pid, uid } = raw as { host?: unknown; pid?: unknown; uid?: unknown };
  if (typeof host !== 'string' || host.length === 0) return undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  return typeof uid === 'number' && Number.isInteger(uid) && uid >= 0
    ? { host, pid, uid }
    : { host, pid };
}

/** Typed view of the run-lifecycle keys on a run's metadata; undefined when unset. */
export function readIdentityUnresolved(
  metadata: Record<string, unknown> | undefined
): boolean | undefined {
  const raw = metadata?.[RUN_METADATA_KEYS.identityUnresolved];
  return typeof raw === 'boolean' ? raw : undefined;
}

/**
 * Key under which a run records WHY it stopped (#3479).
 *
 * A stopped run's status says `failed`, which in this codebase also means
 * "resumable" — so an operator who pressed Ctrl-C sees the same row as an
 * operator whose workflow broke. The categorical cause is already durable in the
 * terminal `workflow_failed` event's `exit_reason`, but no operator surface reads
 * events for it: `workflow get` reads the run row, and the console's list endpoint
 * returns run rows with no events at all. This key is the same fact on the row,
 * so both read it without a second mechanism each.
 *
 * Written by the process that owns the run, from the signal it received. Cleared
 * by `resumeWorkflowRun`, so a resumed-and-completed run does not go on claiming
 * it was interrupted. Absent on runs that stopped before this key existed.
 */
export const RUN_STOP_REASON_METADATA_KEY = 'stop_reason';

/** Typed view of the stop reason; undefined when the run carries none this build can read. */
export function readRunStopReason(
  metadata: Record<string, unknown> | undefined
): RunStopReason | undefined {
  const parsed = runStopReasonSchema.safeParse(metadata?.[RUN_STOP_REASON_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Key under which a paused run that gave back its resource slot records that its
 * continuation was refused for capacity (#4045): `{ since }`, the first refusal. The run
 * is then a capacity waiter: it keeps its place ahead of queued new starts, ordered by
 * `since`, so a later refusal keeps the first value. Cleared by `resumeWorkflowRun` and by
 * `releasePausedRunSlot`, so a later pause never inherits it.
 */
export const CAPACITY_WAIT_METADATA_KEY = 'capacity_wait';

const capacityWaitSchema = z.object({ since: z.string() });

/** Typed view of the capacity wait; undefined when the run carries none this build can read. */
export function readCapacityWait(
  metadata: Record<string, unknown> | undefined
): z.infer<typeof capacityWaitSchema> | undefined {
  const parsed = capacityWaitSchema.safeParse(metadata?.[CAPACITY_WAIT_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Key under which a run released after this host could not read its frozen source
 * (#4209) records where it stopped: `{ nodeId, releaseId, releasedAt, path? }`. Written by
 * `releaseRunForUnreadableSource`, cleared by `resumeWorkflowRun`. It makes the paused
 * run a due `source` continuation, so any host that can read the source continues it.
 */
export const SOURCE_RELEASE_METADATA_KEY = 'source_release';

const sourceReleaseSchema = z.object({
  nodeId: z.string().min(1),
  releaseId: z.string().uuid().optional(),
  releasedAt: z.string().datetime({ offset: true }),
  path: z.string().optional(),
});

export type SourceRelease = z.infer<typeof sourceReleaseSchema>;

/** Typed view of the source release; undefined when the run carries none this build can read. */
export function readSourceRelease(
  metadata: Record<string, unknown> | undefined
): SourceRelease | undefined {
  const parsed = sourceReleaseSchema.safeParse(metadata?.[SOURCE_RELEASE_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Key under which a run records what its DISPATCHING surface resolved for it (#2454).
 *
 * A resume re-enters the executor with whatever the resuming surface happens to hold,
 * and the in-process auto-resume after a child gate holds nothing at all. Re-resolving
 * these from the environment then lets a run change what it is halfway through: the
 * same `$BASE_BRANCH` reference answers a different branch after the gate than before
 * it, and a bundled workflow starts reporting itself as custom. Written once when the
 * run starts and read back on every continuation, so the run keeps the answers it
 * began with. Absent on runs created before this key existed — those continue to
 * re-resolve, which is the behavior they have always had.
 */
export const RUN_DISPATCH_METADATA_KEY = 'dispatch';

export const runDispatchMetadataSchema = z.object({
  /** The resolved `$BASE_BRANCH`. Empty string is a real outcome (folder projects, and
   *  repos where auto-detection failed), which is why absence is carried by the key. */
  base_branch: z.string(),
  /** Discovery source, for run attribution and telemetry categorization. */
  source: workflowSourceSchema.optional(),
});

export type RunDispatchMetadata = z.infer<typeof runDispatchMetadataSchema>;

/** Typed view of the dispatch stamp; undefined when the run carries none this build can read. */
export function readRunDispatchMetadata(
  metadata: Record<string, unknown> | undefined
): RunDispatchMetadata | undefined {
  const parsed = runDispatchMetadataSchema.safeParse(metadata?.[RUN_DISPATCH_METADATA_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Key under which a run records the executable SOURCE it was started from.
 *
 * A run reads its workflows, commands, and scripts from one directory and acts on
 * another. Recording the first is what lets a resume reach the same source a month
 * later, from a different process, after the authoring checkout has moved on. Absent
 * on runs created before source capture existed, and on runs whose source could not
 * be captured — both resolve live, which is exactly the pre-capture behavior.
 */
export const WORKFLOW_SOURCE_METADATA_KEY = 'workflow_source';

/** Source-side settings that decide which executable files a workflow resolves. */
export const workflowSourceConfigSchema = z.object({
  load_default_workflows: z.boolean(),
  load_default_commands: z.boolean(),
  command_folder: z.string().optional(),
  /**
   * Names (never values) from `.archon/config.yaml`'s `env:` section at capture time —
   * the exec env-read checker's "this name is configured" signal for a resumed or
   * child run, which discovers against the frozen capture rather than live config.
   */
  env_var_names: z.array(z.string()).optional(),
});

export type WorkflowSourceConfig = Readonly<z.infer<typeof workflowSourceConfigSchema>>;

/**
 * A run's recorded executable source.
 *
 * `version` exists so a future capture layout can be recognized rather than
 * misread. An unrecognized record fails closed: only a run with no source record
 * may resume against live discovery.
 */
export const workflowSourceMetadataSchema = z.object({
  version: z.literal(1),
  /**
   * Absolute path to the captured source; usable directly as a project root.
   *
   * Absoluteness is enforced rather than assumed: every root reaching here is built from
   * the run's own workspace path, so a relative or blank one means the record is corrupt
   * or foreign. Resolving it against whatever `process.cwd()` happens to be would send
   * every command and script lookup somewhere arbitrary, so the record is unreadable.
   */
  root: z.string().refine(p => isAbsolute(p), { message: 'must be an absolute path' }),
  /** The authoring directory a not-yet-started child captures from. */
  origin: z.string().refine(p => isAbsolute(p), { message: 'must be an absolute path' }),
  captured_at: z.string(),
  /**
   * Content digest of the capture, mirrored from its manifest.
   *
   * Duplicated onto the run row on purpose: it is what lets a reader inspect a run's
   * source identity — and compare two runs — without touching the capture directory,
   * which may since have been reclaimed. Verification still reads the manifest.
   */
  digest: z.string(),
  /**
   * Resolution settings pinned beside the digest, outside the mutable capture.
   * Optional only for runs created before this field shipped.
   */
  source_config: workflowSourceConfigSchema.optional(),
  file_count: z.number(),
  byte_count: z.number(),
});

export type WorkflowSourceMetadata = z.infer<typeof workflowSourceMetadataSchema>;

/**
 * What a run says about its executable source.
 *
 * Three states, and collapsing any two of them is a correctness bug:
 *
 *  - `absent` — the run predates source capture. It has nothing to honor, so it may
 *    resume against live source. This is the ONLY tolerable fallback.
 *  - `recorded` — the run froze source and named it. That source, or nothing.
 *  - `unreadable` — the run recorded SOMETHING this build cannot parse: a corrupt value,
 *    a hand edit, or a future format. Emphatically not the same as `absent`. Treating it
 *    as absent would resume the run against whatever is on disk now, which is exactly
 *    what a run that recorded its source must never do.
 */
export type WorkflowSourceState =
  | { kind: 'absent' }
  | { kind: 'recorded'; record: WorkflowSourceMetadata }
  | { kind: 'unreadable'; detail: string };

export function readWorkflowSourceState(
  metadata: Record<string, unknown> | undefined
): WorkflowSourceState {
  const raw = metadata?.[WORKFLOW_SOURCE_METADATA_KEY];
  if (raw === undefined) return { kind: 'absent' };
  const parsed = workflowSourceMetadataSchema.safeParse(raw);
  return parsed.success
    ? { kind: 'recorded', record: parsed.data }
    : { kind: 'unreadable', detail: parsed.error.message };
}

export { suspendReasonSchema } from './node-state';
export type { SuspendReason } from './node-state';

/**
 * True when `type` is `undefined` (every pause before the field existed, or a plain
 * approval gate that omits it) or a recognized `SuspendReason`. Shared by the CLI
 * `--detach` precheck (`assertApprovable`/`assertRejectable`) and the real
 * approve/reject resolution's exhaustive switches so a precheck success can never
 * diverge from what resolution actually does — an unrecognized reason must be
 * rejected at the SAME point by both, not silently absorbed by one and only later
 * caught by the other (#2489).
 */
export function isRecognizedSuspendReason(type: string | undefined): boolean {
  return type === undefined || suspendReasonSchema.safeParse(type).success;
}

/** Approval context stored in workflow run metadata when paused for human review. */
const approvalContextBaseSchema = z.object({
  nodeId: z.string(),
  /** Unique occurrence identity; absent only on pauses created by older builds. */
  pauseId: z.string().optional(),
  message: z.string(),
  /**
   * Distinguishes the pause kind — see `SuspendReason` above for the resume-path
   * pointer each variant carries:
   *  - `approval`         — a DAG approval node awaiting a human decision.
   *  - `interactive_loop` — an interactive loop gate.
   *  - `writeback`        — the ENGINE-level container write-back gate (Phase C):
   *    no DAG node behind it (`nodeId` is the synthetic `__writeback__`), the
   *    overlay diff of a finished container run awaiting approve→apply / reject→
   *    discard. Reuses the approve/reject CAS machinery; the executor's resume
   *    path branches on the persisted `pending_writeback` marker, not this node.
   *  - `child_workflow`   — a `workflow:` sub-run node (#2121 Phase 2) whose CHILD
   *    run paused at its own gate. The parent pauses "blocked on child"; `nodeId`
   *    is the parent's workflow node, `childRunId` the paused child. The reviewer
   *    approves the CHILD by run id; when the child terminates, the parent_run_id
   *    auto-resume hook re-enters the parent (executor.ts), which re-runs the
   *    workflow node, finds the child terminal, and threads its output. NO
   *    node_completed is written for the parent's node on this pause.
   *  - `fan_out`          — a `fan_out:` workflow node (#4044) whose children have not
   *    all finished because some paused. `nodeId` is the fan-out node, `childRunIds`
   *    the children it waits on. Each child is answered by its own run id; the parent
   *    re-enters once `isFanOutBlockReleased` holds and joins as usual.
   */
  type: suspendReasonSchema.optional(),
  /**
   * Child run id when `type === 'child_workflow'` — the specific paused sub-run
   * the parent is blocked on. Read by the parent auto-resume guard so a DIFFERENT
   * child of the same parent can't trigger the wrong re-entry.
   */
  childRunId: z.string().optional(),
  /**
   * `type === 'fan_out'` only: every non-terminal child of the node at pause time, in
   * item order. A paused child keeps its `max_parallel` slot, so this holds at most
   * the numeric `max_parallel` bound, or all resolved items for `max_parallel: all`.
   */
  childRunIds: z.array(z.string()).optional(),
  /**
   * `type === 'fan_out'` only: items with no child run yet because the `max_parallel`
   * window is full of unfinished children.
   */
  unspawnedItems: z.number().int().min(0).optional(),
  /**
   * Set only on an ESCALATED pause: a `gate:` node that is the sole terminal sink
   * of a `loop_group` body (#2707 step 3), still `type: 'approval'`. The enclosing
   * loop_group's own id occupies `nodeId` — required for the top-level DAG's
   * resume walk to find it (it only knows top-level node ids, never a nested body
   * id) — so this field carries the body gate's own bare id, the one piece the
   * group address would otherwise hide. `approveWorkflow`/`rejectWorkflow`/
   * `respondToWorkflowWithDeclaredDecision` read it to namespace the resolution's
   * `node_completed` event as `<nodeId>.<bodyGateId>` instead of bare `nodeId` —
   * the exact `<groupId>.<bodyId>` step name #2748's `outerNodeOutputs`
   * pre-population already keys on, so the gate's own resolved decision is
   * findable again after a resume the same way any other body node's output is.
   * Absent for every other pause kind, including an ordinary top-level gate.
   */
  bodyGateId: z.string().optional(),
  /** Current loop iteration when paused (interactive loops only). */
  iteration: z.number().optional(),
  /**
   * Session ID to restore on resume (interactive loops only). Gate pauses write an
   * explicit null when the loop has no session cursor to restore; readers treat that
   * exactly like an absent key.
   */
  sessionId: z.string().nullable().optional(),
  /**
   * Provider that created `sessionId` (#1992). Persisted by loop_group gates and
   * restored together with the session id so a resumed loop never threads the
   * session into a node that resolves to a different provider (cross-provider
   * resume is impossible). Same null-means-no-cursor convention as `sessionId`.
   * Absent on single-node loop gates — those restore the session into the same
   * node, so the provider is the same by construction.
   */
  sessionProvider: z.string().nullable().optional(),
  bodySessionCursors: bodySessionCursorsSchema.optional(),
  bodySessionCursorAncestry: bodySessionCursorAncestrySchema.optional(),
  /** When true, the user's approval comment is stored as `$nodeId.output`. Legacy-mode gates only (see `onRejectPrompt`). */
  captureResponse: z.boolean().optional(),
  /** The on_reject prompt template (stored at pause time so reject handlers don't need the workflow def). */
  onRejectPrompt: z.string().optional(),
  /** Max rejection attempts before cancellation (default 3). */
  onRejectMaxAttempts: z.number().optional(),
  /**
   * Gate resolution marker. Set by approve/reject handlers while the run STAYS
   * 'paused' awaiting auto-resume (#2075): 'approved' = approval recorded,
   * 'rejected' = rejection recorded with an on_reject rework staged.
   * null/undefined = gate unresolved (awaiting the human).
   *
   * Lifecycle: never cleared on resume — matching the never-clear convention for
   * approval_response/rejection_reason/loop_user_input (consumed in place). The
   * next fresh pause is what resets it: pauseWorkflowRun REPLACES the whole
   * approval object, so a gate that sets no `resolved` stores none and a prior
   * gate's 'approved' cannot survive to block it (#2673).
   */
  resolved: z.enum(['approved', 'rejected']).nullable().optional(),
  /**
   * Audit facts of the answer that set `resolved`: the surface it arrived through
   * (`cli`, `api`, `manage_run`, or a chat platform id) and when it was committed. Never
   * who answered. Replaced with the rest of the context by the next pause.
   */
  answeredVia: recordSurfaceSchema.optional(),
  answeredAt: z.string().optional(),
  /**
   * Interactive-loop only. True when the iteration this gate paused on emitted the
   * completion signal (detectCompletionSignal / until_bash exit 0). Read at resume by
   * executeLoopNode/executeLoopGroupNode: a signal-bearing gate approved WITHOUT feedback
   * finalizes the node from `signaledOutput` instead of re-running. Cleared by the next
   * fresh pause the same way `resolved` is — the whole approval object is replaced.
   */
  completionSignaled: z.boolean().nullable().optional(),
  /**
   * Interactive-loop only. The (stripped) output of the signal-bearing paused iteration,
   * persisted so the finalize path can write node_completed with the real output for
   * downstream `$nodeId.output` refs. Only set when completionSignaled is true; null otherwise.
   */
  signaledOutput: z.string().nullable().optional(),
  /**
   * Interactive-loop only. The signal-bearing iteration's structured payload (#2637),
   * persisted beside `signaledOutput` so a bare-approve finalize attaches the same
   * `structuredOutput` a natural completion would — without it the two completion
   * routes of one node diverge in `$node.output.field` strictness (finalize would
   * land in the strict text-parse tier while natural completion stays lenient).
   * Only set when completionSignaled is true AND the iteration produced a payload;
   * null otherwise. Absent on gates paused by builds predating this field — those
   * finalize text-only, exactly as before.
   */
  signaledStructuredOutput: z.unknown().optional(),
  /**
   * Single-node `loop` gate only. The paused iteration's (stripped) output, whether or not
   * it signaled, restored on resume as the previous output that `$LOOP_PREV_OUTPUT` and
   * until_bash read. A `loop_group` restores it from its body's persisted rows instead.
   * Absent on gates paused by builds predating this field; those resume with it empty.
   */
  iterationOutput: z.string().optional(),
  /**
   * Interactive-loop only, and written by the single-node `loop` gate ONLY. Cumulative
   * token usage through this pause, restored when the loop resumes so later gates and
   * terminal metadata retain every pre-gate iteration. The historical name remains for
   * compatibility with already-paused runs. A `loop_group` gate deliberately omits it:
   * body nodes persist their own namespaced usage rows before the pause.
   */
  signaledTokens: tokenUsageSchema.nullable().optional(),
  /** Cumulative USD cost through this single-node loop pause; paired with signaledTokens. */
  signaledCostUsd: z.number().nullable().optional(),
  /** Original execution facts retained across a gate; no private session handle. */
  execution: nodeExecutionMetadataSchema.optional(),
  /**
   * Interactive-loop only. Read-once snapshot of the resolved loop prompt
   * template, whether authored as `loop.prompt` or loaded from `loop.command`,
   * persisted at gate pause so the resumed invocation reuses the exact text the
   * run started with. This also takes precedence over an included loop command's
   * load-time compiled prompt/error after rediscovery. Absent on runs paused by builds
   * that predate this field; those resume from the current prompt or command source.
   */
  commandSnapshot: z.string().nullable().optional(),
});

/** Authored vocabularies are required and nonempty; older default gates may omit both fields. */
const approvalDecisionsSchema = z.union([
  z.object({
    decisionsAuthored: z.literal(true),
    decisions: z.array(approvalDecisionConfigSchema).min(1),
  }),
  z.object({
    decisionsAuthored: z.literal(false).optional(),
    decisions: z.array(approvalDecisionConfigSchema).optional(),
  }),
]);

export const approvalContextSchema = approvalContextBaseSchema.and(approvalDecisionsSchema);
export const expectedApprovalGateSchema = z.union([
  z.string().min(1),
  z.object({ nodeId: z.string().min(1), pauseId: z.string().min(1) }),
]);

export type ApprovalContext = z.infer<typeof approvalContextSchema>;

/** Old node-only buttons may resolve only contexts without a pause identity. */
export type ExpectedApprovalGate = z.infer<typeof expectedApprovalGateSchema>;

/**
 * Top-level (non-`approval`) run-metadata keys of the interactive-loop gate
 * protocol, written by approveWorkflow and read at resume by
 * executeLoopNode/executeLoopGroupNode (#2074). Deliberately NOT a Zod schema —
 * run metadata stays schemaless JSON; this alias exists solely so the write and
 * read sites share one key spelling (a typo is a compile error), nothing broader.
 */
export interface LoopGateRunMetadata {
  /** $LOOP_USER_INPUT for the resumed iteration (approve comment; defaults to 'Approved'). */
  loop_user_input?: string;
  /**
   * True iff the approve carried real (non-whitespace) feedback. False/absent =
   * bare approve — finalize-eligible when the gate's completionSignaled is true.
   */
  loop_feedback_given?: boolean;
}

/**
 * True when the run's current approval gate has already been resolved
 * (approved, or rejected with a staged on_reject rework) and the run is
 * paused only while awaiting resume. Guards double-approve/reject, and keeps a
 * resolved gate out of the chat agent's prompt context (#2565) — it is waiting
 * on the machine, not on a human.
 */
export function isGateResolved(approval: ApprovalContext): boolean {
  return approval.resolved === 'approved' || approval.resolved === 'rejected';
}

/**
 * Type guard for ApprovalContext.
 * Validates the gate identity, message and decision vocabulary.
 * Use before accessing `workflowRun.metadata.approval` to prevent runtime throws on
 * malformed metadata (e.g., stale data from older runs where metadata shape differs).
 */
export function isApprovalContext(val: unknown): val is ApprovalContext {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as Record<string, unknown>).nodeId === 'string' &&
    typeof (val as Record<string, unknown>).message === 'string' &&
    approvalDecisionsSchema.safeParse(val).success
  );
}

// ---------------------------------------------------------------------------
// RunAttention — "what does this run need from outside, if anything"
// ---------------------------------------------------------------------------

export const TOOL_CALL_ATTENTION_METADATA_KEY = 'tool_call_attention';

export const toolCallAttentionSchema = z
  .object({
    streamId: z.string().min(1),
    nodeId: z.string().min(1),
    provider: z.string().min(1),
    toolCallId: z.string().min(1),
    name: z.string().min(1).max(1024),
    title: z.string().max(1024).optional(),
    startedAt: z.iso.datetime(),
    lastProgressAt: z.iso.datetime(),
    raisedAt: z.iso.datetime(),
    thresholdMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const toolCallAttentionArraySchema = z.array(toolCallAttentionSchema);
export type ToolCallAttention = z.infer<typeof toolCallAttentionSchema>;

/** Where a gate's response must be recorded — this run, or the child blocking it. */
export const gateAddressSchema = z.object({ runId: z.string(), nodeId: z.string() });
export type GateAddress = z.infer<typeof gateAddressSchema>;

/**
 * Why a run cannot be described, or why nothing will continue it unless someone looks.
 * An enum rather than prose alone because the
 * reasons are not interchangeable to a reader: `assertRejectable` still rejects a
 * run whose gate metadata is unreadable, but must refuse one whose gate type this
 * build does not know — and no caller should tell those apart by matching strings.
 *
 * `malformed_tool_call_attention`, `malformed_gate`, `unrecognized_gate_type`,
 * `child_pointer_missing`, and `source_release_not_continued` come from
 * `runAttention` itself. `child_run_missing` and `child_chain_too_deep` can only be
 * produced by a reader that follows a `blocked_on_child` or `blocked_on_children`
 * pointer into the store (`resolveRunAttention`); the projection is pure and never does.
 */
export const runAttentionUnreadableReasonSchema = z.enum([
  'malformed_tool_call_attention',
  'malformed_gate',
  'unrecognized_gate_type',
  'child_pointer_missing',
  'child_run_missing',
  'child_chain_too_deep',
  'source_release_not_continued',
]);
export type RunAttentionUnreadableReason = z.infer<typeof runAttentionUnreadableReasonSchema>;

const terminalAttentionShape = {
  kind: z.literal('terminal'),
  runId: z.string(),
  status: terminalWorkflowRunStatusSchema,
};

const nonTerminalRunAttentionSchemas = [
  z.object({
    kind: z.literal('stalled_tool_calls'),
    runId: z.string(),
    status: z.literal('running'),
    calls: z.array(
      toolCallAttentionSchema.extend({ elapsedMs: z.number(), stalledForMs: z.number() })
    ),
  }),
  z.object({
    kind: z.literal('awaiting_response'),
    runId: z.string(),
    respondTo: gateAddressSchema,
    message: z.string(),
    occurrence: z.string(),
  }),
  z.object({
    kind: z.literal('attention'),
    runId: z.string(),
    nodeId: z.string(),
    message: z.string(),
    occurrence: z.string(),
    form: attentionFormSchema,
    options: z.array(attentionOptionSchema),
  }),
  z.object({
    kind: z.literal('usage_limit'),
    runId: z.string(),
    nodeId: z.string(),
    resumeAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal('blocked_on_child'),
    runId: z.string(),
    childRunId: z.string(),
    nodeId: z.string(),
  }),
  z.object({
    kind: z.literal('blocked_on_children'),
    runId: z.string(),
    nodeId: z.string(),
    childRunIds: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('unreadable'),
    runId: z.string(),
    reason: runAttentionUnreadableReasonSchema,
    detail: z.string(),
  }),
] as const;

export function createRunAttentionSchema<T extends z.ZodDate | z.ZodString>(
  timestamp: T
): z.ZodDiscriminatedUnion<
  [
    ...typeof nonTerminalRunAttentionSchemas,
    z.ZodObject<typeof terminalAttentionShape & { at: z.ZodNullable<T> }>,
  ],
  'kind'
> {
  return z.discriminatedUnion('kind', [
    ...nonTerminalRunAttentionSchemas,
    z.object({ ...terminalAttentionShape, at: z.nullable(timestamp) }),
  ]);
}

export const runAttentionSchema = createRunAttentionSchema(z.date());
/**
 * Terminal and gate attention, or advisory attention for overdue live tools.
 *
 * `runAttention` returns null for ordinary progress without an advisory, including
 * a resolved gate awaiting auto-resume and a `wait:` node whose timer or event has not fired.
 * `usage_limit` is a run paused on a provider usage limit, or on a rate limit that
 * outlasted its retries: it needs no answer and tries again by itself at `resumeAt`, but an operator may still resume it sooner, cancel it or abandon it.
 *
 * `blocked_on_child` is deliberately NOT an answer to "does someone need to respond".
 * A parent pauses blocked on a child whether that child is sitting on its own gate
 * or merely still running (`pauseParentOnChild` is reached from two sites in
 * `executeWorkflowNode`, the second on a child that is `paused`, `running`, OR `pending`),
 * and the parent row cannot tell those apart. Claiming `awaiting_response` here would
 * wake a host for normal progress; returning null would strand one when the child
 * really is on a gate. So the projection reports what it knows — this run is blocked
 * on that child — and a reader with database access resolves the chain.
 * `blocked_on_children` is the same for a fan-out node waiting on several children:
 * each child is its own queue item, never the parent's.
 */
export type RunAttention = z.infer<typeof runAttentionSchema>;

/** The run shape `runAttention` reads. Structural so a caller can pass a partial row. */
export interface RunAttentionInput {
  id: string;
  status: WorkflowRunStatus;
  metadata?: Record<string, unknown>;
  completed_at?: Date | null;
}

function unreadableAttention(
  runId: string,
  reason: RunAttentionUnreadableReason,
  detail: string
): RunAttention {
  return { kind: 'unreadable', runId, reason, detail };
}

/**
 * The occurrence id of a gate pause: its `pauseId`, or `legacy:<nodeId>` for a gate paused
 * before pause identities existed. Run-attention reports it and answers record it, so a
 * reader can tie an answer to the exact pause it resolved.
 */
export function gateOccurrence(approval: Pick<ApprovalContext, 'nodeId' | 'pauseId'>): string {
  return approval.pauseId ?? `${LEGACY_OCCURRENCE_PREFIX}${approval.nodeId}`;
}

/**
 * The single derivation of "what does this run need from outside, if anything".
 *
 * No database or I/O. The clock computes display durations only. The run row is
 * the authority: attention is never derived from the event log. Every write that
 * changes it commits an event, which the attention watch uses only as a wake, because
 * a delivered event can later be retracted by recovery.
 *
 * Consumed by `assertApprovable`/`assertRejectable`, the server approve/reject/respond
 * routes, the orchestrator's paused-gate prompt section, `waitForRunAttention`, and the
 * attention queue (`attention-queue.ts`).
 * Before this existed each of those re-derived the same four steps independently, in
 * three different orders, and the load-bearing "act on the child, not this run"
 * conclusion survived only inside an error string.
 */
export function runAttention(run: RunAttentionInput, now = Date.now()): RunAttention | null {
  if (isTerminalRunStatus(run.status)) {
    return { kind: 'terminal', runId: run.id, status: run.status, at: run.completed_at ?? null };
  }
  if (run.status === 'running') {
    const raw = run.metadata?.[TOOL_CALL_ATTENTION_METADATA_KEY];
    if (raw === undefined) return null;
    const parsed = toolCallAttentionArraySchema.safeParse(raw);
    if (!parsed.success)
      return unreadableAttention(
        run.id,
        'malformed_tool_call_attention',
        'running with unreadable tool-call attention'
      );
    return parsed.data.length === 0
      ? null
      : {
          kind: 'stalled_tool_calls',
          runId: run.id,
          status: 'running',
          calls: parsed.data.map(call => ({
            ...call,
            elapsedMs: Math.max(0, now - Date.parse(call.startedAt)),
            stalledForMs: Math.max(0, now - Date.parse(call.lastProgressAt)),
          })),
        };
  }
  if (run.status !== 'paused') return null;

  // A release is written only by the running -> paused transition and cleared on resume,
  // so while it is present it is why the run is paused; any gate or wait beside it is
  // history. The host continues a released run, except a container run.
  const release = readSourceRelease(run.metadata);
  if (release) {
    return isContainerRun(run)
      ? unreadableAttention(
          run.id,
          'source_release_not_continued',
          `paused because a host could not read its frozen source for node '${release.nodeId}'; a container run is only resumed by hand`
        )
      : null;
  }

  const wait = run.metadata?.wait;
  if (isWorkflowWaitContext(wait) && wait.kind === 'quota') {
    return { kind: 'usage_limit', runId: run.id, nodeId: wait.nodeId, resumeAt: wait.resumeAt };
  }
  if (isWorkflowWaitContext(wait) && wait.kind === 'attention') {
    // Answered: like a resolved gate, it waits on the machine, not on an answer.
    if (wait.answer !== undefined) return null;
    return {
      kind: 'attention',
      runId: run.id,
      nodeId: workflowWaitStepName(wait),
      message: wait.message,
      occurrence: attentionOccurrence(wait),
      form: attentionForm(wait),
      options: [...attentionOptions(wait)],
    };
  }

  const raw = run.metadata?.approval;
  if (raw === undefined) {
    // No gate recorded. A durable `wait:` owns its own resumption. Anything else is a
    // run parked with nothing that describes why, which nothing but an outside response
    // can unstick.
    return isWorkflowWaitContext(run.metadata?.wait)
      ? null
      : unreadableAttention(
          run.id,
          'malformed_gate',
          'paused with no approval gate and no durable wait recorded'
        );
  }
  if (!isApprovalContext(raw) || raw.nodeId === '') {
    // A gate WAS recorded but cannot be read, or names no node. An `awaiting_response`
    // with an empty address would be a lie, so this stays unreadable.
    return unreadableAttention(
      run.id,
      'malformed_gate',
      'paused with an approval gate this build cannot read'
    );
  }
  if (!isRecognizedSuspendReason(raw.type)) {
    return unreadableAttention(
      run.id,
      'unrecognized_gate_type',
      `unrecognized gate type '${String(raw.type)}'`
    );
  }
  // Resolved: the run is waiting on the machine to resume it, not on a response
  // (see `isGateResolved`).
  if (isGateResolved(raw)) return null;

  if (raw.type === 'child_workflow') {
    if (raw.childRunId === undefined || raw.childRunId === '') {
      // A block pointer with nothing to follow is a corrupt row, not a state to
      // wait on — never a redirect naming '<unknown>'.
      return unreadableAttention(
        run.id,
        'child_pointer_missing',
        `blocked on a sub-run at node '${raw.nodeId}' but the child run id is missing`
      );
    }
    return {
      kind: 'blocked_on_child',
      runId: run.id,
      childRunId: raw.childRunId,
      nodeId: raw.nodeId,
    };
  }
  if (raw.type === 'fan_out') {
    if (raw.childRunIds === undefined || raw.childRunIds.length === 0) {
      return unreadableAttention(
        run.id,
        'child_pointer_missing',
        `blocked on fan-out sub-runs at node '${raw.nodeId}' but no child run ids are recorded`
      );
    }
    return {
      kind: 'blocked_on_children',
      runId: run.id,
      nodeId: raw.nodeId,
      childRunIds: raw.childRunIds,
    };
  }

  // Every remaining recognized reason — `approval`, `interactive_loop`, `writeback`,
  // and `undefined` for legacy plain gates — needs a response from outside the run.
  // Who supplies it is the host's business: a person, or an agent through
  // `archon workflow respond`. The engine only says that one is owed.
  return {
    kind: 'awaiting_response',
    runId: run.id,
    respondTo: { runId: run.id, nodeId: raw.nodeId },
    message: raw.message,
    occurrence: gateOccurrence(raw),
  };
}

/** The run-attention of a run the attention queue lists. */
export type QueuedRunAttention = Extract<
  RunAttention,
  { kind: 'attention' | 'awaiting_response' | 'usage_limit' | 'unreadable' }
>;

/**
 * The run-attention that puts `run` in the attention queue, if any: a paused run with a
 * pause someone must answer, a paused run waiting for a provider usage or rate limit,
 * which an operator may want to see or cancel, or a paused run nothing can read or will
 * continue, which
 * needs someone to look. The queue's list and single read both build items by this one rule.
 */
export function queuedRunAttention(
  run: RunAttentionInput,
  attention: RunAttention | null = runAttention(run)
): QueuedRunAttention | undefined {
  if (run.status !== 'paused' || attention === null) return undefined;
  switch (attention.kind) {
    case 'attention':
    case 'awaiting_response':
    case 'usage_limit':
    case 'unreadable':
      return attention;
    default:
      return undefined;
  }
}

/**
 * True when the attention queue reads `run`: a queue item on its own
 * (`queuedRunAttention`), or a paused parent blocked on sub-runs, which resolves to a
 * child's item or, when its sub-run tree cannot be read, to an unreadable item of its own.
 */
export function isAttentionQueueRow(run: RunAttentionInput): boolean {
  const attention = runAttention(run);
  return (
    queuedRunAttention(run, attention) !== undefined ||
    (run.status === 'paused' &&
      (attention?.kind === 'blocked_on_child' || attention?.kind === 'blocked_on_children'))
  );
}

/**
 * True when a paused run's gate state, on its own, is worth resuming even with
 * ZERO completed DAG nodes — i.e. resolving the run left no `node_completed`
 * row anywhere, but the executor still knows how to make forward progress.
 * Exhaustively switched over `SuspendReason` (#2714) so a future fifth reason
 * cannot silently repeat the gap this closes: a plain `approval` gate whose
 * staged legacy `on_reject` rework was invisible to `hydrateResumableRun`
 * because `rejectWorkflow`'s stage-rework path never writes `node_completed`
 * (only `metadata.approval.resolved`/`rejection_reason`/`rejection_count`).
 *
 * - `interactive_loop` / `child_workflow` / `fan_out` — always true: these kinds
 *   are re-entered by the node executor's own re-read of its state,
 *   independent of `priorCompletedNodes` (`executeLoopNode`/
 *   `executeLoopGroupNode`/`executeWorkflowNode` under dag/nodes/).
 * - `writeback` — always false: there is no DAG node behind this gate to
 *   re-run (`nodeId` is the synthetic `__writeback__`); resolving it flows
 *   through the container write-back resume path, never a node re-run.
 * - `approval` / `undefined` — true ONLY for a genuinely staged legacy
 *   on_reject rework: `resolved === 'rejected'`, a non-empty top-level
 *   `rejection_reason`, and `onRejectPrompt` still present on the approval
 *   context (the same legacy-mode signal `executeApprovalNode` itself checks
 *   before re-running the rework prompt). A new-mode gate (#2707 step 1)
 *   never needs this carve-out: both approve and reject write
 *   `node_completed` immediately, so `priorCompletedNodes` already contains
 *   it by the time this function would be asked.
 */
export function reRunsOwnNodeOnResume(
  approval: ApprovalContext | undefined,
  metadata: Record<string, unknown> | undefined
): boolean {
  if (approval === undefined) return false;
  switch (approval.type) {
    case 'interactive_loop':
    case 'child_workflow':
    case 'fan_out':
      return true;
    case 'writeback':
      return false;
    case 'approval':
    case undefined: {
      const rejectionReason = metadata?.rejection_reason;
      return (
        approval.resolved === 'rejected' &&
        approval.onRejectPrompt !== undefined &&
        typeof rejectionReason === 'string' &&
        rejectionReason !== ''
      );
    }
    default: {
      const unreachable: never = approval.type;
      throw new Error(`reRunsOwnNodeOnResume: unhandled gate type '${String(unreachable)}'`);
    }
  }
}

/**
 * True when `run` is currently paused blocked on the child sub-run `childRunId`
 * (#2121 Phase 2) — i.e. a `paused` run whose `metadata.approval` is a
 * `child_workflow` gate pointing at that child, or a `fan_out` gate listing it in
 * `childRunIds`. This is the single source of the
 * "parent blocked on this child" invariant, shared by the abandon-strand detector
 * (`findParentBlockedOn`, @archon/core) and the auto-resume hook
 * (`maybeResumeParentRun`, @archon/workflows) so the two cannot drift if the gate
 * shape changes. Reads defensively from possibly-malformed metadata.
 */
export function isRunBlockedOnChild(
  run: { status: WorkflowRunStatus; metadata?: Record<string, unknown> },
  childRunId: string
): boolean {
  if (run.status !== 'paused') return false;
  const approval = run.metadata?.approval;
  if (!isApprovalContext(approval)) return false;
  if (approval.type === 'child_workflow') return approval.childRunId === childRunId;
  if (approval.type === 'fan_out') return approval.childRunIds?.includes(childRunId) === true;
  return false;
}

/**
 * True when a parent paused on a `fan_out` gate should continue: every child it waits
 * on is terminal (or has no row), or a slot is free for an unspawned item. A paused
 * child holds its `max_parallel` slot, so with `unspawnedItems > 0` one finished child
 * is enough to let the next item start. `childStatus` returns undefined for a missing row.
 * False for every other gate type.
 */
export function isFanOutBlockReleased(
  approval: ApprovalContext,
  childStatus: (childRunId: string) => WorkflowRunStatus | undefined
): boolean {
  if (approval.type !== 'fan_out') return false;
  const ids = approval.childRunIds ?? [];
  const finished = ids.filter(id => {
    const status = childStatus(id);
    return status === undefined || isTerminalRunStatus(status);
  }).length;
  return finished === ids.length || ((approval.unspawnedItems ?? 0) > 0 && finished > 0);
}

/**
 * True when `run` executed inside an isolation container.
 *
 * Such a run can only be resumed where the docker backend is reachable and the
 * container can be rewired — the CLI. `executeWorkflow` enforces this: a resume
 * without a container context fails the run with a CLI pointer rather than
 * silently running host-side and dropping the write-back. Callers that offer to
 * continue a run consult this FIRST so they never promise a continuation the
 * executor will refuse (#2565). Reads defensively from possibly-absent metadata.
 */
export function isContainerRun(run: { metadata?: Record<string, unknown> }): boolean {
  return run.metadata?.isolation === 'container';
}

// ---------------------------------------------------------------------------
// ArtifactType
// ---------------------------------------------------------------------------

export const artifactTypeSchema = z.enum([
  'pr',
  'commit',
  'file_created',
  'file_modified',
  'branch',
]);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

// ---------------------------------------------------------------------------
// Compile-time assertion: NodeOutput must cover all NodeState values.
// If NodeState gains a new value, this line becomes a type error as a reminder
// to update NodeOutput.
// ---------------------------------------------------------------------------

type AssertNodeOutputCoversNodeState = NodeOutput['state'] extends NodeState
  ? NodeState extends NodeOutput['state']
    ? true
    : never
  : never;
const nodeOutputStateCoverage: AssertNodeOutputCoversNodeState = true;
void nodeOutputStateCoverage; // suppress unused-variable lint warning

export const ownedWorktreeSchema = z
  .object({
    envId: z.string().min(1),
    creationId: z.string().uuid(),
  })
  .strict();
export type OwnedWorktree = z.infer<typeof ownedWorktreeSchema>;

export function readOwnedWorktree(
  metadata: Record<string, unknown> | undefined
): OwnedWorktree | undefined {
  const result = ownedWorktreeSchema.safeParse(metadata?.owned_worktree);
  return result.success ? result.data : undefined;
}
