/**
 * Zod schemas for workflow run state types.
 */
import { z } from '@hono/zod-openapi';
import type { TokenUsage } from '@archon/providers/types';
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
 * `shouldContinueStreamingForStatus` in dag-executor.ts, which encodes this policy.
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

const workflowWaitTimeFields = {
  kind: z.literal('time'),
  waitingSince: z.string().datetime(),
  resumeAt: z.string().datetime(),
} as const;
const workflowWaitEventFields = {
  kind: z.literal('event'),
  waitingSince: z.string().datetime(),
  resumeAt: z.string().datetime(),
  event: z.string().trim().min(1),
  signaledAt: z.string().datetime().optional(),
  payload: z.unknown().optional(),
} as const;
const workflowWaitNodeOwnerFields = {
  owner: z.literal('node'),
  nodeId: z.string().min(1),
} as const;
const workflowWaitLoopOwnerFields = {
  owner: z.literal('loop_group'),
  nodeId: z.string().min(1),
  bodyWaitId: z.string().min(1),
  iteration: z.number().int().positive(),
  sessionId: z.string().nullable(),
  sessionProvider: z.string().nullable(),
} as const;

/**
 * Persisted reason a run is waiting on the outside world rather than a person.
 * Loop-owned cursors carry their complete owner path in the initial pause write;
 * there is no externally visible body-owned intermediate state.
 */
export const workflowWaitContextSchema = z.union([
  z.strictObject({ ...workflowWaitNodeOwnerFields, ...workflowWaitTimeFields }),
  z.strictObject({ ...workflowWaitNodeOwnerFields, ...workflowWaitEventFields }),
  z.strictObject({ ...workflowWaitLoopOwnerFields, ...workflowWaitTimeFields }),
  z.strictObject({ ...workflowWaitLoopOwnerFields, ...workflowWaitEventFields }),
]);
export type WorkflowWaitContext = z.infer<typeof workflowWaitContextSchema>;

export function isWorkflowWaitContext(value: unknown): value is WorkflowWaitContext {
  return workflowWaitContextSchema.safeParse(value).success;
}

export function workflowWaitStepName(wait: WorkflowWaitContext): string {
  return wait.owner === 'loop_group' ? `${wait.nodeId}.${wait.bodyWaitId}` : wait.nodeId;
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

/** Statuses that indicate a run has finished and cannot transition further. */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
] as const;

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

export const nodeStateSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

export type NodeState = z.infer<typeof nodeStateSchema>;

// ---------------------------------------------------------------------------
// NodeOutput
// ---------------------------------------------------------------------------

/**
 * Captured output from a completed DAG node.
 * `output` is the concatenated assistant text (or JSON-encoded string from the SDK
 * when output_format is set). Empty string for a skipped/pending node; for a FAILED
 * node it is usually empty too, but not always — a `loop_group`'s failure paths
 * (body-node failure, `max_iterations` exhaustion, cancellation) deliberately carry
 * the last completed iteration's real, non-empty output. No reader of a 'failed'
 * node's `output` may treat it as trustworthy regardless of content (#2713).
 * `error` is required when state is 'failed', absent on all other states.
 * `structuredOutput` carries the provider's parsed structured payload (set by Pi/Codex/Claude
 * when the result chunk includes one). Downstream `$nodeId.output.field` substitution and
 * `when:` conditions prefer this object over re-parsing `output`, so providers that emit
 * fence-wrapped or preamble-prefixed JSON (Pi/Minimax) survive the round-trip.
 * `declaredFields` is the property-name set of a producer's `output_format` schema
 * (`Object.keys(output_format.properties)`), captured when the node completes. The
 * consumer uses it to tell a declared-but-optional-absent field (resolves to `''`) from a
 * field not in the contract at all (a typo → throws). Undefined for non-schema producers
 * (bash/script/prose) and schemas without a `properties` map.
 */
export const nodeOutputSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['completed', 'running']),
    output: z.string(),
    sessionId: z.string().optional(),
    structuredOutput: z.unknown().optional(),
    declaredFields: z.array(z.string()).optional(),
    /** Session-resume outcome from the provider: false ⇒ a requested resume came
     *  back cold (fresh session). Drives the executor's cold-resume warning.
     *  Absent on 'failed' nodes — the retry path, not this signal, handles those. */
    resumed: z.boolean().optional(),
  }),
  z.object({
    state: z.literal('failed'),
    output: z.string(),
    sessionId: z.string().optional(),
    error: z.string(),
    structuredOutput: z.unknown().optional(),
    declaredFields: z.array(z.string()).optional(),
  }),
  z.object({
    state: z.enum(['pending', 'skipped']),
    output: z.string(),
  }),
]);

export type NodeOutput = z.infer<typeof nodeOutputSchema>;

// ---------------------------------------------------------------------------
// WorkflowRun
// ---------------------------------------------------------------------------

/**
 * Runtime workflow run state stored in database.
 */
export const workflowRunSchema = z.object({
  id: z.string(),
  workflow_name: z.string(),
  conversation_id: z.string(),
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
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

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
 * `require_reported_cost` — run-owned child execution policy inherited from a parent
 *                    spend ceiling. It survives pause/resume independently of the
 *                    original parent call stack.
 */
export const SUBRUN_METADATA_KEYS = {
  parentNodeId: 'parent_node_id',
  childIndex: 'child_index',
  fanOutItemHash: 'fan_out_item_hash',
  inputs: 'inputs',
  inputsValues: 'inputs_values',
  summaryValue: 'summary_value',
  requireReportedCost: 'require_reported_cost',
} as const;

/** Typed view of the sub-run keys on a run's metadata; each is undefined when unset. */
export function readSubrunMetadata(metadata: Record<string, unknown> | undefined): {
  parentNodeId: string | undefined;
  childIndex: number | undefined;
  fanOutItemHash: string | undefined;
  inputs: Record<string, JsonValue> | undefined;
  summaryValue: unknown;
  requireReportedCost: boolean;
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
    requireReportedCost: metadata?.[SUBRUN_METADATA_KEYS.requireReportedCost] === true,
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
 *                       written because `resolveProjectPaths` returned the `_cwd/<basename>`
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
  usageTerminalNodes: 'usage_terminal_nodes',
} as const;

const workflowRunTokenUsageSchema = z
  .strictObject({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative().optional(),
    cacheWrite: z.number().finite().nonnegative().optional(),
    cachePartial: z.literal(true).optional(),
  })
  .superRefine((usage, ctx) => {
    if (
      usage.cachePartial === true &&
      usage.cacheRead === undefined &&
      usage.cacheWrite === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cachePartial'],
        message: 'cachePartial requires at least one reported cache token axis',
      });
    }
  });

export const workflowRunUsageLeafSchema = z.strictObject({
  costUsd: z.number().finite().nonnegative(),
  tokens: workflowRunTokenUsageSchema.optional(),
});

export const workflowRunUsageSchema = workflowRunUsageLeafSchema.extend({
  children: z.record(z.string(), workflowRunUsageLeafSchema).optional(),
});

export type WorkflowRunUsageLeaf = z.infer<typeof workflowRunUsageLeafSchema>;
export type WorkflowRunUsage = z.infer<typeof workflowRunUsageSchema>;

/** Decode cumulative run-row token metadata without inventing required axes. */
export function readWorkflowRunTokenUsage(
  metadata: Record<string, unknown>
): TokenUsage | undefined {
  const input = metadata.total_tokens_in;
  const output = metadata.total_tokens_out;
  const isNonNegativeFinite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!isNonNegativeFinite(input) || !isNonNegativeFinite(output)) return undefined;

  const cacheRead = metadata.total_cache_read_tokens;
  const cacheWrite = metadata.total_cache_write_tokens;
  const raw = {
    input,
    output,
    ...(isNonNegativeFinite(cacheRead) ? { cacheRead } : {}),
    ...(isNonNegativeFinite(cacheWrite) ? { cacheWrite } : {}),
    ...(metadata.total_cache_partial === true &&
    (isNonNegativeFinite(cacheRead) || isNonNegativeFinite(cacheWrite))
      ? { cachePartial: true as const }
      : {}),
  };
  const parsed = workflowRunTokenUsageSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

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

/** Typed view of the run-lifecycle keys on a run's metadata; undefined when unset. */
export function readIdentityUnresolved(
  metadata: Record<string, unknown> | undefined
): boolean | undefined {
  const raw = metadata?.[RUN_METADATA_KEYS.identityUnresolved];
  return typeof raw === 'boolean' ? raw : undefined;
}

/** Per-node cumulative usage persisted atomically with the run total. */
export function readUsageTerminalNodes(
  metadata: Record<string, unknown> | undefined
): ReadonlyMap<string, WorkflowRunUsage> | undefined {
  const raw = metadata?.[RUN_METADATA_KEYS.usageTerminalNodes];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const result = new Map<string, WorkflowRunUsage>();
  for (const [nodeId, value] of Object.entries(raw)) {
    const parsed = workflowRunUsageSchema.safeParse(value);
    if (!parsed.success) return undefined;
    result.set(nodeId, parsed.data);
  }
  return result;
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

/**
 * A run's recorded executable source.
 *
 * `version` exists so a future capture layout can be recognized rather than
 * misread. A reader that does not know a version treats the record as absent and
 * falls back to live discovery with a warning — never as an error, because a paused
 * run must stay resumable across an Archon upgrade.
 */
export const workflowSourceMetadataSchema = z.object({
  version: z.literal(1),
  /**
   * Absolute path to the captured source; usable directly as a project root.
   *
   * Absoluteness is enforced rather than assumed: every root reaching here is built from
   * the run's own artifacts path, so a relative or blank one means the record is corrupt
   * or foreign. Resolving it against whatever `process.cwd()` happens to be would send
   * every command and script lookup somewhere arbitrary, so it reads as absent instead
   * and the run falls back to live source with a warning.
   */
  root: z.string().refine(p => isAbsolute(p), { message: 'must be an absolute path' }),
  /** The authoring directory it was captured from (provenance; never read for lookup). */
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
  file_count: z.number(),
  byte_count: z.number(),
});

export type WorkflowSourceMetadata = z.infer<typeof workflowSourceMetadataSchema>;

/**
 * Typed view of a run's recorded source, or `undefined` when it has none this reader
 * understands. Validation is deliberately total: an unparseable record means "resolve
 * live", not "fail the resume", so a shape change cannot strand paused work.
 */
export function readWorkflowSourceMetadata(
  metadata: Record<string, unknown> | undefined
): WorkflowSourceMetadata | undefined {
  const state = readWorkflowSourceState(metadata);
  return state.kind === 'recorded' ? state.record : undefined;
}

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

/**
 * The suspend reason vocabulary (#2489) — a Zod-backed enum, not a renamed union: the
 * values are persisted verbatim into `workflow_runs.metadata.approval.type`, so they
 * cannot change without breaking reads of already-paused runs. Every pause site now
 * writes through one shared helper (`pauseGateRespectingExternalTransition` in
 * dag-executor.ts), but each reason's RESUME path stays deliberately separate and
 * lives at its own named site:
 *  - `'approval'` / `'interactive_loop'` — resolved externally by a human decision:
 *    `approveWorkflow`/`rejectWorkflow` (operations/workflow-operations.ts).
 *  - `'writeback'` — also resolved by `approveWorkflow`/`rejectWorkflow`'s write-back
 *    branch, then applied on parent resume by `runContainerWriteBackGate`
 *    (dag-executor.ts, `raiseWriteBackGate`'s sibling).
 *  - `'child_workflow'` — never resolved by the approve/reject endpoints directly
 *    (redirected instead — `assertApprovable`/`assertRejectable`); re-inspected by
 *    `executeWorkflowNode` re-running on parent resume (dag-executor.ts).
 */
export const suspendReasonSchema = z.enum([
  'approval',
  'interactive_loop',
  'writeback',
  'child_workflow',
]);
export type SuspendReason = z.infer<typeof suspendReasonSchema>;

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
export interface ApprovalContext {
  nodeId: string;
  message: string;
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
   */
  type?: SuspendReason;
  /**
   * Child run id when `type === 'child_workflow'` — the specific paused sub-run
   * the parent is blocked on. Read by the parent auto-resume guard so a DIFFERENT
   * child of the same parent can't trigger the wrong re-entry.
   */
  childRunId?: string;
  /**
   * Set only on an ESCALATED pause: a `gate:` node that is the sole terminal sink
   * of a `loop_group` body (#2707 step 3), still `type: 'approval'`. The enclosing
   * loop_group's own id occupies `nodeId` — required for the top-level DAG's
   * resume walk to find it (it only knows top-level node ids, never a nested body
   * id) — so this field carries the body gate's own bare id, the one piece the
   * rewrite would otherwise lose. `approveWorkflow`/`rejectWorkflow`/
   * `respondToWorkflowWithDeclaredDecision` read it to namespace the resolution's
   * `node_completed` event as `<nodeId>.<bodyGateId>` instead of bare `nodeId` —
   * the exact `<groupId>.<bodyId>` step name #2748's `outerNodeOutputs`
   * pre-population already keys on, so the gate's own resolved decision is
   * findable again after a resume the same way any other body node's output is.
   * Absent for every other pause kind, including an ordinary top-level gate.
   */
  bodyGateId?: string;
  /** Current loop iteration when paused (interactive loops only). */
  iteration?: number;
  /**
   * Session ID to restore on resume (interactive loops only). Gate pauses write an
   * explicit null when the loop has no session cursor to restore; readers treat that
   * exactly like an absent key.
   */
  sessionId?: string | null;
  /**
   * Provider that created `sessionId` (#1992). Persisted by loop_group gates and
   * restored together with the session id so a resumed loop never threads the
   * session into a node that resolves to a different provider (cross-provider
   * resume is impossible). Same null-means-no-cursor convention as `sessionId`.
   * Absent on single-node loop gates — those restore the session into the same
   * node, so the provider is the same by construction.
   */
  sessionProvider?: string | null;
  /** When true, the user's approval comment is stored as `$nodeId.output`. Legacy-mode gates only (see `onRejectPrompt`). */
  captureResponse?: boolean;
  /** The on_reject prompt template (stored at pause time so reject handlers don't need the workflow def). */
  onRejectPrompt?: string;
  /** Max rejection attempts before cancellation (default 3). */
  onRejectMaxAttempts?: number;
  /**
   * The gate's declared decisions (#2707 step 1), snapshotted at pause time so
   * approve/reject handlers don't need the workflow def to know the vocabulary
   * — mirrors why `onRejectPrompt` is snapshotted rather than looked up.
   * Always populated (synthesized default pair, `on_reject`-translated pair,
   * or the authored array) regardless of mode — see `decisionsAuthored` for
   * the actual mode signal. Absent on gates paused by builds that predate
   * this field.
   */
  decisions?: { id: string; label?: string }[];
  /**
   * True only when the author wrote `approval.decisions:` explicitly in YAML
   * (mirrors `GateNode.decisionsAuthored` — see its doc for the full
   * rationale). THIS, not `onRejectPrompt`'s absence, is the signal
   * `approveWorkflow`/`rejectWorkflow` use to pick the new structured-output
   * resolution path: no workflow authored before #2707 step 1 can have
   * written `decisions:`, so keying the new behavior on it — rather than on
   * "no on_reject configured" — guarantees every already-authored gate
   * (bare, or `capture_response`-only) keeps its exact pre-PR output shape
   * AND reject-always-cancels behavior, unaffected by this PR. Absent (falsy)
   * on gates paused by builds that predate this field, which resolves to
   * legacy behavior — the safe default.
   */
  decisionsAuthored?: boolean;
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
  resolved?: 'approved' | 'rejected' | null;
  /**
   * Interactive-loop only. True when the iteration this gate paused on emitted the
   * completion signal (detectCompletionSignal / until_bash exit 0). Read at resume by
   * executeLoopNode/executeLoopGroupNode: a signal-bearing gate approved WITHOUT feedback
   * finalizes the node from `signaledOutput` instead of re-running. Cleared by the next
   * fresh pause the same way `resolved` is — the whole approval object is replaced.
   */
  completionSignaled?: boolean | null;
  /**
   * Interactive-loop only. The (stripped) output of the signal-bearing paused iteration,
   * persisted so the finalize path can write node_completed with the real output for
   * downstream `$nodeId.output` refs. Only set when completionSignaled is true; null otherwise.
   */
  signaledOutput?: string | null;
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
  signaledStructuredOutput?: unknown;
  /**
   * Interactive-loop only, and written by the single-node `loop` gate ONLY. Cumulative
   * token usage through this pause, restored when the loop resumes so later gates and
   * terminal metadata retain every pre-gate iteration. The historical name remains for
   * compatibility with already-paused runs. A `loop_group` gate deliberately omits it:
   * body nodes persist their own namespaced usage rows before the pause.
   */
  signaledTokens?: TokenUsage | null;
  /** Cumulative USD cost through this single-node loop pause; paired with signaledTokens. */
  signaledCostUsd?: number | null;
  /**
   * Interactive-loop only. Read-once snapshot of the resolved loop prompt
   * template, whether authored as `loop.prompt` or loaded from `loop.command`,
   * persisted at gate pause so the resumed invocation reuses the exact text the
   * run started with. This also takes precedence over an included loop command's
   * load-time compiled prompt/error after rediscovery. Absent on runs paused by builds
   * that predate this field; those resume from the current prompt or command source.
   */
  commandSnapshot?: string | null;
}

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
 * Validates that the value is an object with the required nodeId and message fields.
 * Use before accessing `workflowRun.metadata.approval` to prevent runtime throws on
 * malformed metadata (e.g., stale data from older runs where metadata shape differs).
 */
export function isApprovalContext(val: unknown): val is ApprovalContext {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as Record<string, unknown>).nodeId === 'string' &&
    typeof (val as Record<string, unknown>).message === 'string'
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
 * - `interactive_loop` / `child_workflow` — always true: both kinds are
 *   re-entered by the node executor's own re-read of `metadata.approval`,
 *   independent of `priorCompletedNodes` (`executeLoopNode`/
 *   `executeLoopGroupNode`/`executeWorkflowNode` in dag-executor.ts).
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
 * `child_workflow` gate pointing at that child. This is the single source of the
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
  return (
    isApprovalContext(approval) &&
    approval.type === 'child_workflow' &&
    approval.childRunId === childRunId
  );
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
