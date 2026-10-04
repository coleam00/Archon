/**
 * Zod schemas for workflow run state types.
 */
import {
  declaredOutputPathsSchema,
  outputPathsFromRootFields,
  type DeclaredOutputPaths,
} from '../output-ref';
import { z } from '@hono/zod-openapi';
import { skipCauseSchema, suspendReasonSchema, type NodeState } from './node-state';
import { providerFailureSchema, tokenUsageSchema } from '@archon/provider-contract';
import { nodeExecutionMetadataSchema, nodeFailureKindSchema } from './node-execution';
import { checkoutObservationSchema } from './checkout-observation';
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
const workflowWaitAttentionFields = {
  kind: z.literal('attention'),
  waitingSince: z.string().datetime(),
  message: z.string().trim().min(1),
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
 * Persisted reason a run is waiting outside its current execution.
 * Loop-owned cursors carry their complete owner path in the initial pause write;
 * there is no externally visible body-owned intermediate state.
 */
export const workflowWaitContextSchema = z.union([
  z.strictObject({ ...workflowWaitNodeOwnerFields, ...workflowWaitTimeFields }),
  z.strictObject({ ...workflowWaitNodeOwnerFields, ...workflowWaitEventFields }),
  z.strictObject({ ...workflowWaitNodeOwnerFields, ...workflowWaitAttentionFields }),
  z.strictObject({ ...workflowWaitLoopOwnerFields, ...workflowWaitTimeFields }),
  z.strictObject({ ...workflowWaitLoopOwnerFields, ...workflowWaitEventFields }),
  z.strictObject({ ...workflowWaitLoopOwnerFields, ...workflowWaitAttentionFields }),
]);
export type WorkflowWaitContext = z.infer<typeof workflowWaitContextSchema>;
export type WorkflowAttentionWaitContext = Extract<WorkflowWaitContext, { kind: 'attention' }>;

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

/** Narrowing membership test for `TERMINAL_WORKFLOW_STATUSES`. */
export function isTerminalRunStatus(status: WorkflowRunStatus): status is RunTerminalStatus {
  return TERMINAL_STATUS_TUPLE.some(terminal => terminal === status);
}

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
  if (run.status !== 'paused') return undefined;
  const wait = run.metadata.wait;
  if (!isWorkflowWaitContext(wait) || wait.kind === 'attention') return undefined;
  return wait;
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
 * dead from it.
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

/** The complete gate snapshot, persisted before requesting a decision. */
export const approvalContextSchema = z.object({
  nodeId: z.string(),
  message: z.string(),
  type: suspendReasonSchema.optional(),
  childRunId: z.string().optional(),
  // An enclosing loop group owns resume; its body gate owns the decision event.
  bodyGateId: z.string().optional(),
  iteration: z.number().int().optional(),
  sessionId: z.string().nullable().optional(),
  sessionProvider: z.string().nullable().optional(),
  captureResponse: z.boolean().optional(),
  onRejectPrompt: z.string().optional(),
  onRejectMaxAttempts: z.number().int().optional(),
  decisions: z.array(z.object({ id: z.string(), label: z.string().optional() })).optional(),
  // Only authored decisions opt into structured output and resumable rejection.
  decisionsAuthored: z.boolean().optional(),
  resolved: z.enum(['approved', 'rejected']).nullable().optional(),
  completionSignaled: z.boolean().nullable().optional(),
  signaledOutput: z.string().nullable().optional(),
  signaledStructuredOutput: z.unknown().optional(),
  // Cumulative loop usage through the suspended iteration; the field names are persisted contracts.
  signaledTokens: tokenUsageSchema.nullable().optional(),
  signaledCostUsd: z.number().nullable().optional(),
  execution: nodeExecutionMetadataSchema.optional(),
  // The resolved loop template survives cold resume, including command-backed loops.
  commandSnapshot: z.string().nullable().optional(),
  gateId: z.string().optional(),
  admissionOwnerId: z.string().optional(),
  admission: z.enum(['collecting', 'queued', 'active']).optional(),
  presentation: z.enum(['unclaimed', 'claimed', 'delivered']).optional(),
});
export type ApprovalContext = z.infer<typeof approvalContextSchema>;

export const gateResponseSchema = z.object({
  resolved: z.enum(['approved', 'rejected']),
  approval_response: z.string().optional(),
  rejection_reason: z.string().optional(),
  rejection_count: z.number().int().nonnegative().optional(),
  loop_user_input: z.string().optional(),
  loop_feedback_given: z.boolean().optional(),
});
export type GateResponse = z.infer<typeof gateResponseSchema>;

const gateRecordFields = {
  id: z.string().min(1),
  runId: z.string().min(1),
  context: approvalContextSchema
    .omit({
      resolved: true,
      gateId: true,
      admissionOwnerId: true,
      admission: true,
      presentation: true,
    })
    .strict(),
  readyForPresentation: z.boolean(),
  presentation: z.enum(['unclaimed', 'claimed', 'delivered']),
};
export const pendingGateSchema = z.object(gateRecordFields);
export const resolvedGateSchema = z.object({
  ...gateRecordFields,
  response: gateResponseSchema,
});
export const gateQueueSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(['collecting', 'parked']),
    active: pendingGateSchema.nullable(),
    pending: z.array(pendingGateSchema),
    resolved: z.array(resolvedGateSchema),
  })
  .strict()
  .superRefine((queue, ctx) => {
    const records = [...(queue.active ? [queue.active] : []), ...queue.pending, ...queue.resolved];
    if (new Set(records.map(record => record.id)).size !== records.length) {
      ctx.addIssue({ code: 'custom', message: 'Gate identities must be unique' });
    }
    if (queue.active === null && queue.pending.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'Pending gates require an active gate' });
    }
  });
export type PendingGate = z.infer<typeof pendingGateSchema>;
export type ResolvedGate = z.infer<typeof resolvedGateSchema>;
export type GateQueue = z.infer<typeof gateQueueSchema>;
export type GateAdmission =
  | { status: 'already_resolved'; ownerId: string; gate: ResolvedGate }
  | { status: 'registered'; ownerId: string; gateId: string; position: 'active' | 'queued' }
  | { status: 'externally_stopped'; runId: string; runStatus: WorkflowRunStatus | null };

/** Missing is legacy; malformed modern state must never fall back to a fresh gate. */
export function readGateQueue(metadata: Record<string, unknown>): GateQueue | undefined {
  return metadata.gate_queue === undefined ? undefined : gateQueueSchema.parse(metadata.gate_queue);
}

export function gateProjection(
  queue: GateQueue,
  gate: PendingGate,
  ownerId: string
): ApprovalContext {
  return {
    ...gate.context,
    gateId: gate.id,
    admissionOwnerId: ownerId,
    admission:
      gate.id !== queue.active?.id
        ? 'queued'
        : queue.phase === 'collecting' || !gate.readyForPresentation
          ? 'collecting'
          : 'active',
    presentation: gate.presentation,
  };
}

/** Select only this invocation's response; modern gates never inherit run-wide feedback. */
export function gateContinuationMetadata(
  queue: GateQueue,
  runId: string,
  nodeId: string
): Record<string, unknown> | undefined {
  const record = queue.resolved
    .slice()
    .reverse()
    .find(gate => gate.runId === runId && gate.context.nodeId === nodeId);
  return record
    ? {
        ...record.response,
        approval: { ...record.context, resolved: record.response.resolved, gateId: record.id },
      }
    : undefined;
}

/** Legacy top-level loop response keys; modern gates retain these on their own record. */
export type LoopGateRunMetadata = Pick<GateResponse, 'loop_user_input' | 'loop_feedback_given'>;

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

// ---------------------------------------------------------------------------
// RunAttention — "what does this run need from outside, if anything"
// ---------------------------------------------------------------------------

/** Where a gate's response must be recorded — this run, or the child blocking it. */
export interface GateAddress {
  /** The run the response is recorded against. NOT always the run that was asked about. */
  runId: string;
  /** The gate node inside that run. */
  nodeId: string;
  gateId?: string;
}

/**
 * Why a run cannot be described. An enum rather than prose alone because the
 * reasons are not interchangeable to a reader: `assertRejectable` still rejects a
 * run whose gate metadata is unreadable, but must refuse one whose gate type this
 * build does not know — and no caller should tell those apart by matching strings.
 *
 * `malformed_gate`, `unrecognized_gate_type`, and `child_pointer_missing` come from
 * `runAttention` itself. `child_run_missing` and `child_chain_too_deep` can only be
 * produced by a reader that follows a `blocked_on_child` pointer into the database
 * (`waitForRunAttention`, @archon/core); the projection is pure and never does.
 */
export type RunAttentionUnreadableReason =
  | 'malformed_gate'
  | 'malformed_queue'
  | 'unrecognized_gate_type'
  | 'child_pointer_missing'
  | 'child_run_missing'
  | 'child_chain_too_deep';

/**
 * A run has reached a state it will not leave without someone acting.
 *
 * `runAttention` returns null while the run is still progressing under its own
 * power, which includes a resolved gate awaiting auto-resume and a `wait:` node
 * whose timer or event has not fired.
 *
 * `blocked_on_child` is deliberately NOT an answer to "does someone need to respond".
 * A parent pauses blocked on a child whether that child is sitting on its own gate
 * or merely still running (`pauseParentOnChild` is reached from two sites in
 * dag-executor.ts, the second on a child that is `paused`, `running`, OR `pending`),
 * and the parent row cannot tell those apart. Claiming `awaiting_response` here would
 * wake a host for normal progress; returning null would strand one when the child
 * really is on a gate. So the projection reports what it knows — this run is blocked
 * on that child — and a reader with database access resolves the chain.
 */
export type RunAttention =
  | { kind: 'terminal'; runId: string; status: RunTerminalStatus; at: Date | null }
  | { kind: 'awaiting_response'; runId: string; respondTo: GateAddress; message: string }
  | {
      kind: 'admission_pending';
      runId: string;
      ownerId: string;
      gateId: string;
      phase: 'collecting' | 'queued' | 'presentation';
    }
  | {
      kind: 'action_required';
      runId: string;
      nodeId: string;
      message: string;
    }
  | { kind: 'blocked_on_child'; runId: string; childRunId: string; nodeId: string }
  | { kind: 'unreadable'; runId: string; reason: RunAttentionUnreadableReason; detail: string };

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
 * Pure: no database, no clock, no I/O. The run ROW is the authority — attention is
 * never derived from the event log, because terminal transitions exist that write no
 * terminal event (`resolveAndCancelApprovalGate` cancels a run while inserting only
 * `approval_received`), and two gate pauses write an unreliable event or none at all.
 *
 * Consumed by `assertApprovable`/`assertRejectable`, the server approve/reject/respond
 * routes, the orchestrator's paused-gate prompt section, and `waitForRunAttention`.
 * Before this existed each of those re-derived the same four steps independently, in
 * three different orders, and the load-bearing "act on the child, not this run"
 * conclusion survived only inside an error string.
 */
export function runAttention(run: RunAttentionInput): RunAttention | null {
  if (isTerminalRunStatus(run.status)) {
    return { kind: 'terminal', runId: run.id, status: run.status, at: run.completed_at ?? null };
  }
  if (run.status !== 'paused') return null;

  if (
    run.metadata?.gate_queue !== undefined &&
    !gateQueueSchema.safeParse(run.metadata.gate_queue).success
  ) {
    return unreadableAttention(
      run.id,
      'malformed_queue',
      'the durable gate admission queue cannot be read'
    );
  }

  const wait = run.metadata?.wait;
  if (isWorkflowWaitContext(wait) && wait.kind === 'attention') {
    return {
      kind: 'action_required',
      runId: run.id,
      nodeId: workflowWaitStepName(wait),
      message: wait.message,
    };
  }

  const ownedQueue =
    run.metadata?.gate_queue === undefined ? undefined : readGateQueue(run.metadata);
  const raw =
    ownedQueue?.active?.runId === run.id
      ? gateProjection(ownedQueue, ownedQueue.active, run.id)
      : run.metadata?.approval;
  if (ownedQueue?.active === null && (!isApprovalContext(raw) || raw.type !== 'child_workflow'))
    return null;
  if (raw === undefined) {
    // No gate recorded. A durable `wait:` owns its own resumption. Anything else is
    // a run parked with nothing that describes why, which nothing but an outside
    // response can unstick.
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

  if (raw.admission !== undefined) {
    if (
      !approvalContextSchema.safeParse(raw).success ||
      (ownedQueue && raw.gateId !== ownedQueue.active?.id)
    ) {
      return unreadableAttention(
        run.id,
        'malformed_queue',
        'gate projection does not match its admission queue'
      );
    }
    if (!raw.gateId || !raw.admissionOwnerId) {
      return unreadableAttention(
        run.id,
        'malformed_queue',
        'gate projection has no durable admission identity'
      );
    }
    if (raw.admission !== 'active' || raw.presentation === 'unclaimed') {
      return {
        kind: 'admission_pending',
        runId: run.id,
        ownerId: raw.admissionOwnerId,
        gateId: raw.gateId,
        phase: raw.admission === 'active' ? 'presentation' : raw.admission,
      };
    }
  }

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

  // Every remaining recognized reason — `approval`, `interactive_loop`, `writeback`,
  // and `undefined` for legacy plain gates — needs a response from outside the run.
  // Who supplies it is the host's business: a person, or an agent through
  // `archon workflow respond`. The engine only says that one is owed.
  return {
    kind: 'awaiting_response',
    runId: run.id,
    respondTo: { runId: run.id, nodeId: raw.nodeId, ...(raw.gateId ? { gateId: raw.gateId } : {}) },
    message: raw.message,
  };
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
