/**
 * Run attention: what a run needs from outside, if anything, derived from its row alone.
 */
import { z } from 'zod';
import {
  type ApprovalContext,
  isApprovalContext,
  isGateResolved,
  isRecognizedSuspendReason,
} from './approval-context';
import { attentionOccurrence, gateOccurrence } from './pause-occurrence';
import { isContainerRun, readSourceRelease } from './run-metadata';
import {
  isTerminalRunStatus,
  terminalWorkflowRunStatusSchema,
  type WorkflowRunStatus,
} from './run-status';
import {
  attentionForm,
  attentionOptions,
  isWorkflowWaitContext,
  workflowWaitStepName,
} from './run-wait';
import { attentionFormSchema, attentionOptionSchema } from './wait-node';
import type { WorkflowRun } from './workflow-run';

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
  if (run.status === 'running') return runningAttention(run, now);
  if (run.status !== 'paused') return null;
  return pausedAttention(run);
}

/** A running run needs attention only for tool calls that stopped reporting progress. */
function runningAttention(run: RunAttentionInput, now: number): RunAttention | null {
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

/** A paused run is released, waiting, or at a gate, checked in that order. */
function pausedAttention(run: RunAttentionInput): RunAttention | null {
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
    return isWorkflowWaitContext(wait)
      ? null
      : unreadableAttention(
          run.id,
          'malformed_gate',
          'paused with no approval gate and no durable wait recorded'
        );
  }
  return gateAttention(run.id, raw);
}

/** The attention a recorded gate asks for: none once resolved, else whom to answer. */
function gateAttention(runId: string, raw: unknown): RunAttention | null {
  if (!isApprovalContext(raw) || raw.nodeId === '') {
    // A gate WAS recorded but cannot be read, or names no node. An `awaiting_response`
    // with an empty address would be a lie, so this stays unreadable.
    return unreadableAttention(
      runId,
      'malformed_gate',
      'paused with an approval gate this build cannot read'
    );
  }
  if (!isRecognizedSuspendReason(raw.type)) {
    return unreadableAttention(
      runId,
      'unrecognized_gate_type',
      `unrecognized gate type '${String(raw.type)}'`
    );
  }
  // Resolved: the run is waiting on the machine to resume it, not on a response
  // (see `isGateResolved`).
  if (isGateResolved(raw)) return null;
  if (raw.type === 'child_workflow') return childBlockAttention(runId, raw);
  if (raw.type === 'fan_out') return childrenBlockAttention(runId, raw);

  // Every remaining recognized reason — `approval`, `interactive_loop`, `writeback`,
  // and `undefined` for legacy plain gates — needs a response from outside the run.
  // Who supplies it is the host's business: a person, or an agent through
  // `archon workflow respond`. The engine only says that one is owed.
  return {
    kind: 'awaiting_response',
    runId,
    respondTo: { runId, nodeId: raw.nodeId },
    message: raw.message,
    occurrence: gateOccurrence(raw),
  };
}

function childBlockAttention(runId: string, gate: ApprovalContext): RunAttention {
  if (gate.childRunId === undefined || gate.childRunId === '') {
    // A block pointer with nothing to follow is a corrupt row, not a state to
    // wait on — never a redirect naming '<unknown>'.
    return unreadableAttention(
      runId,
      'child_pointer_missing',
      `blocked on a sub-run at node '${gate.nodeId}' but the child run id is missing`
    );
  }
  return { kind: 'blocked_on_child', runId, childRunId: gate.childRunId, nodeId: gate.nodeId };
}

function childrenBlockAttention(runId: string, gate: ApprovalContext): RunAttention {
  if (gate.childRunIds === undefined || gate.childRunIds.length === 0) {
    return unreadableAttention(
      runId,
      'child_pointer_missing',
      `blocked on fan-out sub-runs at node '${gate.nodeId}' but no child run ids are recorded`
    );
  }
  return { kind: 'blocked_on_children', runId, nodeId: gate.nodeId, childRunIds: gate.childRunIds };
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
