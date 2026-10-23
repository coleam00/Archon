/**
 * IWorkflowStore - persistence port for workflow operations.
 *
 * Mirrors the IIsolationStore pattern from @archon/isolation.
 * SQL lives in @archon/core; append-only files live in @archon/workflows.
 * the workflow engine depends only on this narrow interface.
 *
 * The records and rules every store shares live in `./store/` by area and are
 * re-exported here, so this stays the one import path for the port.
 */
import type { IResourceStartStore } from './resource-start-store';
import type { CheckoutObservation } from './schemas/checkout-observation';
import type { ProviderEventQuery, ProviderEventRecord } from './schemas/provider-event';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { ExpectedApprovalGate } from './schemas/workflow-run';
import type { ListDashboardRunsOptions, DashboardRunsResult } from './schemas/workflow-run-listing';
import type {
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowRunStatus,
  ApprovalContext,
  WorkflowAttentionWaitContext,
  WorkflowWaitContext,
  WorkflowNodeSession,
  WorkflowRunNodeSession,
} from './schemas';
import type { IStateDocumentStore } from './state-document-store';
import type { AttentionAnswerWrite, AttentionLabelWrite } from './store/attention-writes';
import type { PauseCursor, WorkflowResumeCursor } from './store/continuation-cursors';
import type { IWorkflowEventFeed } from './store/event-feed';
import type {
  GatePauseEventInput,
  GateResolutionEvent,
  NodeStateEventInput,
  ObservabilityEventInput,
  WorkflowEventInput,
  WorkflowEventType,
} from './store/event-types';
import type { DagResumeSnapshot } from './store/resume-snapshot';
import type { WorkflowRunFailureOptions } from './workflow-run-failure';
import type {
  FanOutCancelReason,
  SourceReleaseWrite,
  WorkflowCancellationEventDetails,
  WorkflowWaitCompletion,
  WorkflowWaitPause,
} from './store/run-writes';

export type { WorkflowNodeSession, WorkflowRunNodeSession } from './schemas';
export * from './store/attention-writes';
export * from './store/continuation-cursors';
export * from './store/errors';
export * from './store/event-feed';
export * from './store/event-types';
export * from './store/resume-snapshot';
export * from './store/run-writes';
export type { WorkflowRunFailureOptions } from './workflow-run-failure';

/** Composite primary key identifying a single persisted node session row. */
export interface WorkflowNodeSessionKey {
  workflow_name: string;
  node_id: string;
  scope_key: string;
  provider: string;
}

/** Where an install persists workflow state; selected by `store:` in the global config. */
export const WORKFLOW_STORE_KINDS = ['database', 'files'] as const;
export type WorkflowStoreKind = (typeof WORKFLOW_STORE_KINDS)[number];

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

export interface IWorkflowStore
  extends IRunTreeStore,
    IWorkflowRunNodeSessionStore,
    IResourceStartStore,
    IStateDocumentStore,
    IWorkflowEventFeed {
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
  /** Event reads use explicit UTC offsets; batched reads preserve durable append order. */
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
  /**
   * Return at most `limit` due continuations, defaulting to 25: time waits past their
   * deadline, signaled event waits, due quota resumes, and answered gates and attention
   * waits (`answeredPauseContinuation`), and runs released for an unreadable source
   * (`readSourceRelease`). Timed ones come earliest first, answered pauses after.
   */
  listDueWorkflowContinuations(now: Date, limit?: number): Promise<WorkflowRun[]>;
  /** Back off only the unchanged wait, quota, answered or source occurrence; a stale cursor writes nothing. */
  deferWorkflowContinuation(
    id: string,
    retryAt: string,
    cursor: WorkflowResumeCursor
  ): Promise<void>;
  /**
   * Atomically add one answer to the stored attention wait (`answeredAttentionWait`) and
   * commit its `wait_answered` audit row (`waitAnsweredEvent`), without changing
   * lifecycle. Writes nothing, and returns `answered: false`, when the run is no longer
   * paused at that unanswered wait.
   */
  answerAttentionWait(id: string, write: AttentionAnswerWrite): Promise<{ answered: boolean }>;
  /**
   * Atomically apply one label write to an open attention wait (`labeledAttentionWait`)
   * and commit its `attention_labeled` audit row (`attentionLabeledEvent`). Writes
   * nothing, and returns `labeled: false`, when the run is no longer paused at that
   * unanswered wait.
   */
  labelAttentionWait(
    id: string,
    write: AttentionLabelWrite
  ): Promise<{ labeled: true; wait: WorkflowAttentionWaitContext } | { labeled: false }>;
  /**
   * Every row the attention queue reads (`isAttentionQueueRow`), most recently started
   * first. The rows only: `@archon/workflows/attention-queue` builds the items.
   */
  listAttentionQueueRows(): Promise<WorkflowRun[]>;
  /** Atomically record an unexpired event signal and its audit event without changing lifecycle. */
  signalWorkflowWait(
    id: string,
    wait: Extract<WorkflowWaitContext, { kind: 'event' }>,
    payload?: unknown
  ): Promise<{ signaled: boolean }>;
  /**
   * A resume of a run admitted through a resource start takes a slot or throws
   * `WorkflowResourceBusyError` (`resourceResumeBlocker`). A paused run refused while ready
   * to continue (answered, due or signaled, or claimed with a `cursor`) records its first
   * refusal (`CAPACITY_WAIT_METADATA_KEY`) before the error is thrown, so it keeps its place
   * while the host retries (`resumeRefusal`).
   */
  resumeWorkflowRun(id: string, cursor?: WorkflowResumeCursor): Promise<WorkflowRun>;
  /**
   * Give back the resource slot of a run admitted through a resource start, while it is
   * still paused at exactly `cursor`, and clear any capacity wait it carries. Called once
   * nothing of the run executes any more. `released` is false when the run moved on, never
   * held a slot, or already gave it back; a capacity wait then stays, keeping its place.
   */
  releasePausedRunSlot(id: string, cursor: PauseCursor): Promise<{ released: boolean }>;
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
  /** Atomically merge metadata only while running; false means nothing was written. */
  updateWorkflowRunMetadataIfRunning(
    id: string,
    metadata: WorkflowRun['metadata']
  ): Promise<boolean>;
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
   * Atomically fail a pending or running run and persist its matching lifecycle event.
   * `failed` is false when the run was already terminal: a no-op that leaves the winning
   * outcome in place, so the caller must not announce its own failure. Missing runs and
   * other start states reject.
   * `exitReason` is recorded on that event as the run's categorical failure cause, and — with
   * `signal`, when a signal arriving at the owning process is what stopped the run —
   * on the run row as `metadata.stop_reason`, which is what the operator surfaces
   * read (#3479). Reports terminal telemetry after a won commit (see completeWorkflowRun).
   */
  failWorkflowRun(
    id: string,
    error: string,
    options?: WorkflowRunFailureOptions
  ): Promise<{ failed: boolean }>;
  /**
   * Pause a running run for human review, stamping the approval context. Optional
   * `extraMetadata` is folded into the SAME atomic metadata write (e.g. the
   * container write-back gate's `pending_writeback` marker) so there is never a
   * paused-without-marker window. `event` is committed with the pause, so a decision
   * cannot be followed by a stale node_suspended row and the pause reaches the event
   * feed; every executor gate pause supplies one.
   */
  pauseWorkflowRun(
    id: string,
    approvalContext: ApprovalContext,
    extraMetadata?: Record<string, unknown>,
    event?: GatePauseEventInput
  ): Promise<void>;
  /**
   * Claim-checked release from running to paused for unreadable source; status/claim losers write nothing.
   * Atomically writes source_release (store-minted releaseId/releasedAt), continuation_retry_at, and source_released.
   * beforePublish runs under exclusion against resume; rejection aborts the transition.
   * It must be repeatable (SQL may retry), without store I/O or event publication.
   */
  releaseRunForUnreadableSource(
    id: string,
    release: SourceReleaseWrite,
    beforePublish?: () => Promise<void>
  ): Promise<{ released: boolean }>;
  /**
   * Pause a running run on a wait, committing `wait_started` for a new wait or
   * `wait_continued` (`waitContinuedEvent`) for one a resume reached again.
   */
  pauseWorkflowRunForWait(
    id: string,
    waitContext: WorkflowWaitContext,
    pause: WorkflowWaitPause
  ): Promise<void>;
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
