import type { IResourceStartStore } from './resource-start-store';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { ExpectedApprovalGate } from './schemas/workflow-run';
import type { ResourceStartDisposition } from './schemas/resource-start';
import type { ListDashboardRunsOptions, DashboardRunsResult } from './schemas/workflow-run-listing';
import type { DeclaredOutputPaths } from './output-ref';
import {
  serializeNodeStateRecord,
  DEFERRED_NODE_USAGE_EVENT_TYPE,
  type SerializedDeferredNodeUsageEvent,
  type SerializedNodeEvent,
} from './node-record-serialization';
import type { NodeExecutionMetadata, NodeExecutionRecord } from './schemas/node-execution';
import type { CheckoutObservation } from './schemas/checkout-observation';
import type { RunCancelReason, RunExitReason, RunStopSignal } from './schemas/run-terminal-reason';
import type { ProviderEventQuery, ProviderEventRecord } from './schemas/provider-event';
/**
 * IWorkflowStore - persistence port for workflow operations.
 *
 * Mirrors the IIsolationStore pattern from @archon/isolation.
 * SQL lives in @archon/core; append-only files live in @archon/workflows.
 * the workflow engine depends only on this narrow interface.
 */
import type {
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowRunStatus,
  ApprovalContext,
  WorkflowAttentionWaitContext,
  WorkflowWaitContext,
  WorkflowWaitResult,
  ScheduledWorkflowResume,
  WorkflowNodeSession,
  WorkflowRunNodeSession,
} from './schemas';
import type { TokenUsage } from '@archon/provider-contract';
import type { FanOutInstanceSnapshot } from './fan-out-identity';

export type { WorkflowNodeSession, WorkflowRunNodeSession } from './schemas';

/**
 * One completed node's persisted result, as rehydrated for resume (#2637).
 * `structuredOutput` is the logical value the node's `node_completed` event carried
 * under `structured_output`; absent for text-only nodes and rows persisted before
 * the key existed — those degrade to text re-parsing, the pre-#2637 behavior.
 * `declaredOutputPaths` is the field-path contract the node completed under. Resume
 * uses it only for a producer whose loaded definition states no contract, such as a
 * `workflow:` node whose contract is the child's; a local producer's own schema wins.
 * A row with only the legacy `declared_fields` reads as depth-1 paths.
 */
export interface PersistedNodeOutput {
  output: string;
  structuredOutput?: unknown;
  declaredOutputPaths?: DeclaredOutputPaths;
  /** Present only when resume recovered a preview rather than the full text.
   * Replay must retain this original provenance instead of certifying the preview. */
  outputTruncation?: { originalBytes: number | null; spillPath: string | null };
  /**
   * The execution facts of the completion this output came from, carried across prior-
   * success replays so a resumed consumer reads the same producer record a fresh run
   * would (`$node.execution.checkoutStart`). Absent on rows written before those facts.
   */
  execution?: NodeExecutionMetadata;
}

export interface DagResumeSnapshot {
  /** Latest unfinished invocation, keyed by canonical path and enclosing loop lineage. */
  unfinishedInvocations?: Map<string, NodeExecutionMetadata>;
  completedNodeOutputs: Map<string, PersistedNodeOutput>;
  /** First durable ordered snapshot for each instance-qualified composed fan-out scope. */
  fanOutSnapshots: Map<string, readonly FanOutInstanceSnapshot[]>;
  /** Node/instance starts with no later terminal event, in lifecycle order. */
  unresolvedNodeStarts: Set<string>;
  tokens?: TokenUsage;
  /** Cumulative USD cost persisted by completed/failed attempts and abandoned deferred segments. */
  costUsd: number;
}

/** Durable wait outcome committed atomically with consumption of its active cursor. */
export interface WorkflowWaitCompletion {
  execution?: NodeExecutionRecord;
  stepName: string;
  result: WorkflowWaitResult;
}

export type WorkflowWaitPause = { kind: 'started'; stepName: string } | { kind: 'continued' };

/** Exact persisted cursor expected by an automatic continuation claim. */
export type WorkflowResumeCursor =
  | { kind: 'wait'; nodeId: string; resumeAt: string }
  | { kind: 'quota'; attempt: number; resumeAt: string };

/** Composite primary key identifying a single persisted node session row. */
export interface WorkflowNodeSessionKey {
  workflow_name: string;
  node_id: string;
  scope_key: string;
  provider: string;
}

export const NODE_LIFECYCLE_EVENT_TYPES = [
  'node_started',
  'node_suspended',
  'node_completed',
  'node_failed',
  'node_skipped',
  'node_skipped_prior_success',
] as const;

export type NodeLifecycleEventType = (typeof NODE_LIFECYCLE_EVENT_TYPES)[number];

/** Node state writes must remain durable, including resume-cache invalidations. */
export const NODE_STATE_EVENT_TYPES = [
  ...NODE_LIFECYCLE_EVENT_TYPES,
  // #2402 — written when a cached prior-success node is invalidated because a
  // dependency re-executed during the current resume (e.g. an `always_run: true`
  // upstream, or any dep that re-ran with fresh output). `data.prior_output` is the
  // stale cached value being thrown away; `data.invalidating_deps` lists the
  // upstream node ids whose current output no longer matches the prior snapshot.
  // The audit counterpart to the resume cache invalidation; absence never implies
  // the cache was honored — a skipped node only writes `node_skipped_prior_success`.
  'node_prior_cache_invalidated',
  'node_always_run_reset',
] as const;

export type NodeStateEventType = (typeof NODE_STATE_EVENT_TYPES)[number];

export function foldActiveNodeIds(
  active: Set<string>,
  stepName: string | null,
  eventType: NodeStateEventType
): void {
  if (!stepName) return;
  if (eventType === 'node_started' || eventType === 'node_suspended') active.add(stepName);
  else active.delete(stepName);
}

export const DURABLE_WORKFLOW_EVENT_TYPES = [
  ...NODE_STATE_EVENT_TYPES,
  DEFERRED_NODE_USAGE_EVENT_TYPE,
] as const;
export type DurableWorkflowEventType = (typeof DURABLE_WORKFLOW_EVENT_TYPES)[number];
export type DurableNodeEventInput = NodeStateEventInput | SerializedDeferredNodeUsageEvent;

export const WORKFLOW_EVENT_TYPES = [
  'run_attention_changed',
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  // #2348 — written by the resume CAS ONLY when it clears a non-empty
  // `metadata.error`, carrying that error in `data.error`. It is the audit
  // record for a legacy failure that resume would otherwise erase (older CLI
  // SIGTERM handlers could record a failure in metadata and nowhere else), NOT
  // a general "a resume happened" marker: its absence never means the run wasn't resumed.
  'workflow_resumed',
  // Between-run continuation (#2747) — written on the ADOPTING run's log when it
  // starts with `--adopt`/`--supersedes`, so the chain renders from events alone.
  'workflow.run_adopted',
  ...DURABLE_WORKFLOW_EVENT_TYPES,
  'node_retry_scheduled',
  'loop_iteration_started',
  'loop_iteration_completed',
  'loop_iteration_failed',
  // #3569 — one provider event in the engine envelope (`schemas/provider-event.ts`).
  // Read through `IWorkflowStore.listProviderEvents`.
  'provider_event',
  'ralph_story_started',
  'ralph_story_completed',
  'approval_requested',
  'approval_received',
  'wait_started',
  'wait_signaled',
  'wait_completed',
  'wait_expired',
  'quota_resume_scheduled',
  'quota_resume_triggered',
  'quota_resume_exhausted',
  'quota_resume_skipped',
  'workflow_cancelled',
  'workflow_artifact',
  'integration_operation',
  'node_session_resumed',
  // A persisted session the node did not continue because its provider cannot fork it;
  // continuing in place could put two runs into one provider conversation (#2667).
  'node_session_not_continued',
  // Container isolation backend lifecycle (folder-project container runs).
  // `container_created`/`container_destroyed` bracket the run; `container_stopped`/
  // `container_resumed` bracket a suspend/resume across a pause (Phase C).
  'container_created',
  'container_stopped',
  'container_resumed',
  'container_destroyed',
  // Container write-back gate (Phase C): the finished run's overlay diff is
  // requested (paused for approval), then applied to / discarded from the live root.
  'writeback_requested',
  'writeback_applied',
  'writeback_discarded',
  // File-presence gate (#2230): `evidence_policy.required` was set but its
  // conventional `$ARTIFACTS_DIR/evidence.json` marker was absent at completion.
  // Data carries the expected path; the legacy event name is a persisted contract.
  'evidence_validation_failed',
  // #2213 — keys the engine dropped from this run's workflow YAML. Written by the
  // executor at run start for EVERY run that has them, whatever surface started
  // it, so the record does not depend on a chat/console notification being
  // deliverable. `data.warnings` is the message list. Absence means the YAML was
  // clean OR the run predates this event type — never that delivery failed.
  'workflow_parse_warnings',
  // #2781 — the run's workflow declares `deprecated:`. Written by the executor at
  // run start for every deprecated workflow, whatever surface started it (the
  // chat/console message is best-effort; this is the durable trace).
  // `data.notice` is the composed message; absence means not deprecated OR the run
  // predates this event type.
  'workflow_deprecation_notice',
  // #2512 — audit snapshot of a composed fan-out's ordered instance set (identity +
  // item per ordinal), written before the first instance schedules.
  'fan_out_instances',
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

/**
 * Rows that recorded provider activity before `provider_event` replaced them. Nothing
 * writes them any more; `listProviderEvents` translates the ones already stored.
 */
export const LEGACY_PROVIDER_EVENT_TYPES = [
  'tool_called',
  'tool_completed',
  'task_activity',
  'hook_activity',
] as const;

export const PROVIDER_EVENT_ROW_TYPES = ['provider_event', ...LEGACY_PROVIDER_EVENT_TYPES] as const;

export function isDurableWorkflowEventType(
  value: WorkflowEventType
): value is DurableWorkflowEventType {
  return DURABLE_WORKFLOW_EVENT_TYPES.some(eventType => eventType === value);
}

/** The column payload shared by every workflow-event writer. */
export interface WorkflowEventInput<EventType extends WorkflowEventType = WorkflowEventType> {
  workflow_run_id: string;
  event_type: EventType;
  step_index?: number;
  step_name?: string;
  data?: Record<string, unknown>;
}

export type NodeStateEventInput = SerializedNodeEvent;
export type ObservabilityEventInput = WorkflowEventInput<
  Exclude<WorkflowEventType, DurableWorkflowEventType>
>;

/**
 * The two rows a wait's completion produces: the wait outcome for observability and
 * the node's own completed state. A wait completes on one of two paths, in the same
 * tick inside the executor or on resume inside the store's cursor-clearing
 * transaction, and both paths must write the same rows for the same result. This is
 * the only place that knows their shape.
 */
export function waitCompletionEvents(
  workflowRunId: string,
  completion: WorkflowWaitCompletion
): { outcome: ObservabilityEventInput; node: NodeStateEventInput } {
  const { stepName, result } = completion;
  return {
    outcome: {
      workflow_run_id: workflowRunId,
      event_type: result.status === 'expired' ? 'wait_expired' : 'wait_completed',
      step_name: stepName,
      data: result,
    },
    node:
      completion.execution !== undefined
        ? serializeNodeStateRecord(completion.execution)
        : {
            workflow_run_id: workflowRunId,
            event_type: 'node_completed',
            step_name: stepName,
            data: {
              type: 'wait',
              duration_ms: result.waited_ms,
              node_output: JSON.stringify(result),
              structured_output: result,
            },
          },
  };
}

export const FAN_OUT_CANCEL_REASONS = [
  'fan_out_gate',
  'fan_out_sibling',
  'fan_out_orphan',
] as const;
export type FanOutCancelReason = (typeof FAN_OUT_CANCEL_REASONS)[number];

export interface WorkflowCancellationEventDetails {
  step_name?: string;
  reason?: string;
  /** Categorical cause, reported to telemetry; `reason` is free text and never is. */
  cancel_reason?: RunCancelReason;
}

/**
 * Run-tree navigation (#2121 Phase 2) — a narrow, distinct concern (walking the
 * `parent_run_id` graph) kept out of the fat `IWorkflowStore` per the project's ISP
 * rule. `IWorkflowStore` extends it so existing consumers don't churn, but a caller
 * that only needs run-tree reads can depend on this alone.
 */
export interface IRunTreeStore {
  /**
   * Find every run whose `parent_run_id` is `parentRunId`. Used by a `workflow:`
   * node's re-entry logic to locate its child (filtered further by
   * `metadata.parent_node_id`) and by the abandon cascade to cancel children.
   */
  findChildRuns(parentRunId: string): Promise<WorkflowRun[]>;
  /**
   * Walk the `parent_run_id` chain from `runId` UP to the root, returning the
   * ancestors (nearest parent first), depth-capped. Used by the runtime cycle
   * guard (reject a child whose target name is already an ancestor) and to build
   * the path-lock exclusion set.
   */
  getRunAncestry(runId: string): Promise<WorkflowRun[]>;
}

export interface IWorkflowRunNodeSessionStore {
  listWorkflowRunNodeSessions(workflowRunId: string): Promise<readonly WorkflowRunNodeSession[]>;
  upsertWorkflowRunNodeSession(params: {
    workflow_run_id: string;
    node_id: string;
    provider: string;
    provider_session_id: string;
  }): Promise<void>;
}

/** Only a zero-row pause CAS produces this error; storage failures must propagate. */
export class WorkflowRunPauseConflictError extends Error {
  constructor(runId: string) {
    super(`Workflow run not found or not in running state (id: ${runId})`);
    this.name = 'WorkflowRunPauseConflictError';
  }
}

export interface IWorkflowStore
  extends IRunTreeStore, IWorkflowRunNodeSessionStore, IResourceStartStore {
  setToolCallAttention(
    runId: string,
    streamId: string,
    calls: import('./schemas/workflow-run').ToolCallAttention[]
  ): Promise<boolean>;
  /** Resolve an open paused gate and commit its audit events atomically; a CAS loser writes nothing. */
  resolveApprovalGate(
    id: string,
    metadata: Record<string, unknown>,
    events: GateResolutionEvent[],
    expectedGate?: ExpectedApprovalGate
  ): Promise<{ resolved: boolean }>;
  /** Resolve, cancel and commit gate plus terminal events atomically; reports telemetry after a winning commit. */
  resolveAndCancelApprovalGate(
    id: string,
    events: GateResolutionEvent[],
    cancellation: WorkflowCancellationEventDetails,
    expectedGate?: ExpectedApprovalGate
  ): Promise<{ resolved: boolean }>;
  /**
   * Atomically cancel resumable runs matching conversation_id or parent_conversation_id; return their pre-cancellation rows.
   * Invoke assertMayCancel on the locked snapshot before any write; a thrown refusal aborts the transaction.
   */
  cancelResumableRunsForConversation(
    conversationId: string,
    assertMayCancel?: (runs: WorkflowRun[]) => void
  ): Promise<WorkflowRun[]>;
  deleteWorkflowNodeSessions(filter: {
    workflow_name: string;
    scope_key?: string;
    node_id?: string;
  }): Promise<{ deleted: number }>;
  findWorkflowRunsByIdPrefix(prefix: string, codebaseId: string): Promise<WorkflowRun[]>;
  listWorkflowRuns(options?: ListDashboardRunsOptions): Promise<DashboardRunsResult>;

  findOpenWorkRuns(options?: { codebaseId?: string; limit?: number }): Promise<WorkflowRun[]>;
  findAdoptingRuns(runId: string): Promise<WorkflowRun[]>;
  deleteOldWorkflowRuns(olderThanDays: number): Promise<{ count: number }>;
  /** Event reads return created_at with an explicit UTC offset, independent of storage dialect. */
  listWorkflowEvents(
    runId: string,
    options?: { excludeEventTypes?: readonly string[] }
  ): Promise<WorkflowEventRow[]>;
  listEventsForRuns(
    runIds: readonly string[],
    eventTypes: readonly WorkflowEventType[]
  ): Promise<Map<string, WorkflowEventRow[]>>;

  // Run lifecycle
  createWorkflowRun(data: {
    /**
     * Caller-reserved row id, from `prepareWorkflowSource`. Supplied when the run's
     * frozen workflow source had to be written at this run's own source path before
     * the row existed. Omitted, the store generates one.
     */
    id?: string;
    workflow_name: string;
    origin?: import('./schemas/workflow-run').WorkflowRunOrigin;
    codebase_id?: string;
    user_message: string;
    metadata?: Record<string, unknown>;
    working_path?: string;
    /**
     * Run-tree parent (#2121 Phase 2). Set for a `workflow:` sub-run so its row
     * links back to the spawning parent run; omitted for top-level runs.
     */
    parent_run_id?: string;
    /**
     * Between-run continuation (#2747). Set when this run adopts a terminal
     * run's estate (or supersedes it); written once at creation, never on
     * resume. Omitted for ordinary fresh runs.
     */
    adopted_from_run_id?: string;
  }): Promise<WorkflowRun>;
  /**
   * Fresh execution must win this pending-to-running CAS before doing any work.
   * `workingPath` is the checkout the run will use; the claim stamps it on a row
   * created without one.
   */
  claimPendingWorkflowRun(id: string, workingPath?: string): Promise<WorkflowRun | null>;
  /**
   * Record the run's checkout baseline (#3305). Write-once in the store: the first value
   * sticks and a later call returns it unchanged. Returns the persisted baseline.
   */
  recordWorkflowRunCheckoutBaseline(
    id: string,
    baseline: CheckoutObservation
  ): Promise<CheckoutObservation>;
  getWorkflowRun(id: string): Promise<WorkflowRun | null>;
  /**
   * Find the workflow run currently holding the lock on `workingPath`.
   *
   * Pass `self` from the calling dispatch so:
   *   1. Self is never returned (excluded by `id != self.id`).
   *   2. Two near-simultaneous dispatches deterministically agree on which
   *      is "first" via the `(started_at, id)` tiebreaker — newer aborts.
   *
   * `id` and `startedAt` must travel together — the tiebreaker requires
   * both. Bundling them as a single optional struct makes the
   * paired-or-nothing invariant structural rather than a doc-only contract.
   *
   * Stale `pending` rows (older than ~5 minutes) are treated as orphaned
   * and ignored, so leaks from crashed dispatches don't permanently block
   * a path.
   *
   * `excludeRunIds` additionally drops those run ids from the active set. A
   * `workflow:` sub-run shares its parent's checkout (#2121 Phase 2), so the
   * child's path-lock must exclude its ancestor chain — otherwise the child
   * self-blocks against the parent's own `running`/`paused` row on that path.
   */
  getActiveWorkflowRunByPath(
    workingPath: string,
    self?: { id: string; startedAt: Date; excludeRunIds?: string[] }
  ): Promise<WorkflowRun | null>;
  findResumableRun(workflowName: string, workingPath: string): Promise<WorkflowRun | null>;
  /** Return at most `limit` due continuations, defaulting to 25. */
  listDueWorkflowContinuations(now: Date, limit?: number): Promise<WorkflowRun[]>;
  /** Back off only the unchanged wait/quota occurrence; a stale cursor writes nothing. */
  deferWorkflowContinuation(
    id: string,
    retryAt: string,
    cursor: WorkflowResumeCursor
  ): Promise<void>;
  /** Atomically record an unexpired event signal and its audit event without changing lifecycle. */
  signalWorkflowWait(
    id: string,
    wait: Extract<WorkflowWaitContext, { kind: 'event' }>,
    payload?: unknown
  ): Promise<{ signaled: boolean }>;
  resumeWorkflowRun(id: string, cursor?: WorkflowResumeCursor): Promise<WorkflowRun>;
  /** Claim an engine-cancelled fan-out child for immediate in-process recovery. */
  recoverCancelledFanOutRun(id: string): Promise<WorkflowRun>;
  /**
   * `output_root` (#2200) is write-once: the executor sets it at run start only
   * when the persisted value is null. Re-writing it on resume would re-derive
   * the path from a possibly-renamed codebase and orphan the run's artifacts,
   * defeating the whole point of persisting it.
   *
   * `working_path` (#2872) is write-once for the same reason and exists for the
   * same shape: a row created before its checkout was decided. `run --detach`
   * creates the row in the launching process — so `Started` means a queryable
   * run — and forks before any worktree exists, so the child fills the path in
   * once it has one. Every other caller supplies it at creation.
   */
  updateWorkflowRun(
    id: string,
    updates: Partial<Pick<WorkflowRun, 'metadata' | 'output_root'>> & {
      status?: Exclude<WorkflowRunStatus, 'completed' | 'failed' | 'cancelled'>;
      outcome?: WorkflowRunOutcome;
      working_path?: string;
    }
  ): Promise<void>;
  updateWorkflowActivity(id: string): Promise<void>;
  getWorkflowRunStatus(id: string): Promise<WorkflowRunStatus | null>;
  /**
   * Atomically complete the run and persist its matching lifecycle event.
   *
   * Every terminal writer (complete, fail, cancel, fan-out cancel, and the failure of a
   * paused attention wait) also owes terminal telemetry: after its write commits and
   * only when it won the status change, it reports `buildRunTerminalTelemetry` over the
   * run's row and event log. The engine sends no terminal event itself. The SQL store
   * does this in `packages/core/src/db/workflow-terminal-telemetry.ts`.
   */
  completeWorkflowRun(
    id: string,
    completion: { duration_ms: number },
    metadata?: Record<string, unknown>
  ): Promise<void>;
  /**
   * Atomically fail the run and persist its matching lifecycle event. `exitReason`
   * is recorded on that event as the run's categorical failure cause, and — with
   * `signal`, when a signal arriving at the owning process is what stopped the run —
   * on the run row as `metadata.stop_reason`, which is what the operator surfaces
   * read (#3479). Reports terminal telemetry after a won commit (see completeWorkflowRun).
   */
  failWorkflowRun(
    id: string,
    error: string,
    options?: {
      scheduledResume?: ScheduledWorkflowResume;
      exitReason?: RunExitReason;
      signal?: RunStopSignal;
    }
  ): Promise<void>;
  /**
   * Pause a running run for human review, stamping the approval context. Optional
   * `extraMetadata` is folded into the SAME atomic metadata write (e.g. the
   * container write-back gate's `pending_writeback` marker) so there is never a
   * paused-without-marker window. The optional suspension is committed with the
   * pause so a decision cannot be followed by a stale node_suspended row.
   */
  pauseWorkflowRun(
    id: string,
    approvalContext: ApprovalContext,
    extraMetadata?: Record<string, unknown>,
    suspension?: NodeStateEventInput
  ): Promise<void>;
  /** Pause a running run and record its engine-owned wait start atomically. */
  pauseWorkflowRunForWait(
    id: string,
    waitContext: WorkflowWaitContext,
    pause: WorkflowWaitPause
  ): Promise<void>;
  /**
   * Fail the exact paused action-required cursor after its required notification is lost.
   * Reports terminal telemetry after a won commit (see completeWorkflowRun).
   */
  failPausedAttentionWait(
    id: string,
    waitContext: WorkflowAttentionWaitContext,
    error: string
  ): Promise<{ failed: boolean }>;
  /**
   * Consume the exact wait cursor and persist its completion snapshot atomically. Both
   * rows come from `waitCompletionEvents`, and the node's `node_completed` row is
   * handed back so the caller derives the transcript and emitter from the row that
   * exists rather than rebuilding it (#3255).
   */
  clearWorkflowWaitContext(
    id: string,
    waitContext: WorkflowWaitContext,
    completion: WorkflowWaitCompletion
  ): Promise<{ cleared: false } | { cleared: true; nodeEvent: NodeStateEventInput }>;
  /** Fail only this still-unresolved gate when its required prompt cannot be delivered. */
  failPausedApproval(
    id: string,
    approvalContext: ApprovalContext,
    error: string
  ): Promise<{ failed: boolean }>;

  /**
   * Atomically CLAIM the container write-back apply before the live root is mutated
   * (retry-safe apply). Sets `metadata.writeback_apply_claimed` only while unset;
   * returns whether THIS caller won. Apply the overlay only when `claimed`.
   */
  claimWriteback(id: string): Promise<{ claimed: boolean }>;

  /**
   * Release a claimed write-back apply after the apply FAILED, so a later resume can
   * re-claim and retry. Best-effort (never throws in the caller's critical path).
   */
  releaseWritebackClaim(id: string): Promise<void>;
  /**
   * Atomically cancel the run and persist its matching lifecycle event.
   * Reports terminal telemetry after a won commit (see completeWorkflowRun).
   */
  cancelWorkflowRun(
    id: string,
    event?: WorkflowCancellationEventDetails
  ): Promise<{ cancelled: boolean }>;
  /**
   * Atomically identify and cancel a fan-out child owned by the engine.
   * Reports terminal telemetry after a won commit (see completeWorkflowRun).
   */
  cancelFanOutRun(id: string, reason: FanOutCancelReason): Promise<{ cancelled: boolean }>;

  /**
   * Create a workflow event. Implementations MUST NOT throw — catch all errors
   * internally and log them. Callers treat this as observable-only: workflow
   * execution continues regardless of whether event persistence succeeds.
   */
  createWorkflowEvent(data: ObservabilityEventInput): Promise<void>;

  /**
   * Persist a correctness-critical workflow event and propagate any storage failure.
   * Use only when execution must not proceed without the row; ordinary observability
   * belongs on `createWorkflowEvent`.
   */
  persistWorkflowEvent(data: WorkflowEventInput): Promise<void>;

  /**
   * Atomically persist a correctness-critical event while the run is running. Claimed
   * deterministic work may explicitly extend that claim through a parent pause.
   */
  persistWorkflowEventIfRunning(
    data: WorkflowEventInput,
    options?: { allowPaused?: boolean }
  ): Promise<{ persisted: boolean }>;

  /**
   * Return completed node outputs and cumulative token usage from a prior DAG
   * workflow run. Used for resume hydration so completed nodes are skipped and
   * the run-level token tally includes every execution of the run.
   *
   * Throws on DB error — caller (executor.ts) owns the degradation policy.
   */
  getDagResumeSnapshot(workflowRunId: string): Promise<DagResumeSnapshot>;

  /**
   * A run's provider events, one node's or all of them, as served. Records come grouped
   * by node, and within a node in emission order (attempts in the order they started,
   * each by `seq`). With `after`, only the node's records after that cursor.
   * Rows written before `provider_event` existed come back translated, with a null
   * `attemptId`. Throws on storage error.
   */
  listProviderEvents(runId: string, query?: ProviderEventQuery): Promise<ProviderEventRecord[]>;

  // Per-codebase env vars for workflow node injection
  getCodebaseEnvVars(codebaseId: string): Promise<Record<string, string>>;

  // Codebase lookup (for path resolution)
  getCodebase(id: string): Promise<{
    id: string;
    name: string;
    repository_url: string | null;
    default_cwd: string;
    /** Project kind — 'folder' routes path resolution to _folder/<slug>/ storage. */
    kind: 'repo' | 'folder';
  } | null>;

  // Per-node provider sessions persisted across workflow re-runs (opt-in via
  // `persist_session: true` on a node, or `persist_sessions: true` at workflow root).
  // The executor lists a scope's rows once at run start, so a run continues the sessions
  // that existed when it started, never one a concurrent run wrote afterwards (#2667).
  listWorkflowNodeSessions(scope: {
    workflow_name: string;
    scope_key: string;
  }): Promise<readonly WorkflowNodeSession[]>;
  upsertWorkflowNodeSession(
    params: WorkflowNodeSessionKey & {
      provider_session_id: string;
      last_run_id: string | null;
    }
  ): Promise<void>;
}

/**
 * An audit event written atomically with a gate resolution (#2146). The winning
 * resolver inserts these in the SAME transaction as the resolution UPDATE, so a
 * failed event write rolls the resolution back — a resolved gate can never be
 * left with no audit trail, which the fast-path guard would then wrongly block
 * from retrying. `workflow_run_id` is supplied by the CAS function.
 */
export type GateResolutionEvent =
  | Omit<NodeStateEventInput, 'workflow_run_id'>
  | {
      event_type: Exclude<WorkflowEventType, NodeStateEventInput['event_type']>;
      step_name: string;
      data: Record<string, unknown>;
    };

/**
 * Thrown by resumeWorkflowRun when the target run is no longer in a resumable
 * state (already running/terminal, or concurrently resumed). Callers translate
 * this into a user-facing "already being resumed" message instead of leaking
 * the raw internal error string.
 */
export class WorkflowNotResumableError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentStatus: string
  ) {
    super(
      `Workflow run is not resumable (id: ${runId}, status: ${currentStatus}). ` +
        'It may have already been resumed, completed, or cancelled.'
    );
    this.name = 'WorkflowNotResumableError';
  }
}

export class WorkflowResourceBusyError extends Error {
  constructor(
    public readonly runId: string,
    public readonly blocker: Extract<ResourceStartDisposition, { status: 'queued' }>['blocker']
  ) {
    super(
      `Workflow run '${runId}' cannot resume while ${blocker.kind === 'run' ? 'resource owner' : 'queued request'} '${blocker.id}' has priority.`
    );
    this.name = 'WorkflowResourceBusyError';
  }
}
