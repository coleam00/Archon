/**
 * IWorkflowStore - trait interface for workflow database operations.
 *
 * Mirrors the IIsolationStore pattern from @archon/isolation.
 * Implementations live in @archon/core (backed by the real DB);
 * the workflow engine depends only on this narrow interface.
 */
import type {
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowRunStatus,
  ApprovalContext,
  WorkflowWaitContext,
  WorkflowWaitResult,
  ScheduledWorkflowResume,
  WorkflowNodeSession,
  WorkflowRunNodeSession,
} from './schemas';
import type { TokenUsage } from '@archon/providers/types';

export type { WorkflowNodeSession, WorkflowRunNodeSession } from './schemas';

/**
 * One completed node's persisted result, as rehydrated for resume (#2637).
 * `structuredOutput` is the logical value the node's `node_completed` event carried
 * under `structured_output`; absent for text-only nodes and rows persisted before
 * the key existed — those degrade to text re-parsing, the pre-#2637 behavior.
 */
export interface PersistedNodeOutput {
  output: string;
  structuredOutput?: unknown;
}

export interface DagResumeSnapshot {
  completedNodeOutputs: Map<string, PersistedNodeOutput>;
  tokens?: TokenUsage;
  /** Cumulative USD cost persisted by completed and failed node attempts across prior passes. */
  costUsd: number;
}

/** Durable wait outcome committed atomically with consumption of its active cursor. */
export interface WorkflowWaitCompletion {
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

export const WORKFLOW_EVENT_TYPES = [
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  // #2348 — written by the resume CAS ONLY when it clears a non-empty
  // `metadata.error`, carrying that error in `data.error`. It is the audit
  // record for a failure that resume would otherwise erase (the CLI's SIGTERM
  // handler records a failure in metadata and nowhere else), NOT a general
  // "a resume happened" marker: its absence never means the run wasn't resumed.
  'workflow_resumed',
  // Between-run continuation (#2747) — written on the ADOPTING run's log when it
  // starts with `--adopt`/`--supersedes`, so the chain renders from events alone.
  'workflow.run_adopted',
  'node_started',
  'node_completed',
  'node_failed',
  'node_skipped',
  'node_skipped_prior_success',
  // #2402 — written when a cached prior-success node is invalidated because a
  // dependency re-executed during the current resume (e.g. an `always_run: true`
  // upstream, or any dep that re-ran with fresh output). `data.prior_output` is the
  // stale cached value being thrown away; `data.invalidating_deps` lists the
  // upstream node ids whose current output no longer matches the prior snapshot.
  // The audit counterpart to the resume cache invalidation; absence never implies
  // the cache was honored — a skipped node only writes `node_skipped_prior_success`.
  'node_prior_cache_invalidated',
  'node_always_run_reset',
  'provider_slot_queued',
  'provider_slot_acquired',
  'loop_iteration_started',
  'loop_iteration_completed',
  'loop_iteration_failed',
  'tool_called',
  'tool_completed',
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
  'node_session_resumed',
  // Phase 2 of #975 — subagent task lifecycle (aggregated from provider
  // task_started / task_progress / task_notification chunks). Stored
  // alongside other workflow_events for the timeline view; the SSE bridge
  // fans out task_activity / hook_activity to live Web UI subscribers.
  'task_activity',
  'hook_activity',
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
  // Evidence gate (#2230): `evidence_policy.required` was set but
  // `$ARTIFACTS_DIR/evidence.json` was absent at completion time — the run was
  // refused terminal `completed` and marked failed. Data carries the expected path.
  'evidence_validation_failed',
  // #2213 — keys the engine dropped from this run's workflow YAML. Written by the
  // executor at run start for EVERY run that has them, whatever surface started
  // it, so the record does not depend on a chat/console notification being
  // deliverable. `data.warnings` is the message list. Absence means the YAML was
  // clean OR the run predates this event type — never that delivery failed.
  'workflow_parse_warnings',
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

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

export interface IWorkflowStore extends IRunTreeStore, IWorkflowRunNodeSessionStore {
  // Run lifecycle
  createWorkflowRun(data: {
    /**
     * Caller-reserved row id, from `prepareWorkflowSource`. Supplied when the run's
     * frozen workflow source had to be written at this run's own artifacts path before
     * the row existed. Omitted, the store generates one.
     */
    id?: string;
    workflow_name: string;
    conversation_id: string;
    codebase_id?: string;
    user_message: string;
    metadata?: Record<string, unknown>;
    working_path?: string;
    parent_conversation_id?: string;
    /** Archon user UUID; populated via ExecuteWorkflowOptions.userId. */
    user_id?: string;
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
  failOrphanedRuns(): Promise<{ count: number }>;
  resumeWorkflowRun(id: string, cursor?: WorkflowResumeCursor): Promise<WorkflowRun>;
  /**
   * `output_root` (#2200) is write-once: the executor sets it at run start only
   * when the persisted value is null. Re-writing it on resume would re-derive
   * the path from a possibly-renamed codebase and orphan the run's artifacts,
   * defeating the whole point of persisting it.
   */
  updateWorkflowRun(
    id: string,
    updates: Partial<Pick<WorkflowRun, 'status' | 'metadata' | 'output_root'>> & {
      outcome?: WorkflowRunOutcome;
    }
  ): Promise<void>;
  updateWorkflowActivity(id: string): Promise<void>;
  getWorkflowRunStatus(id: string): Promise<WorkflowRunStatus | null>;
  completeWorkflowRun(id: string, metadata?: Record<string, unknown>): Promise<void>;
  failWorkflowRun(
    id: string,
    error: string,
    scheduledResume?: ScheduledWorkflowResume
  ): Promise<void>;
  /**
   * Pause a running run for human review, stamping the approval context. Optional
   * `extraMetadata` is folded into the SAME atomic metadata write (e.g. the
   * container write-back gate's `pending_writeback` marker) so there is never a
   * paused-without-marker window.
   */
  pauseWorkflowRun(
    id: string,
    approvalContext: ApprovalContext,
    extraMetadata?: Record<string, unknown>
  ): Promise<void>;
  /** Pause a running run and record its engine-owned wait start atomically. */
  pauseWorkflowRunForWait(
    id: string,
    waitContext: WorkflowWaitContext,
    pause: WorkflowWaitPause
  ): Promise<void>;
  /** Consume the exact wait cursor and persist its completion snapshot atomically. */
  clearWorkflowWaitContext(
    id: string,
    waitContext: WorkflowWaitContext,
    completion: WorkflowWaitCompletion
  ): Promise<{ cleared: boolean }>;
  /**
   * Rewrite the approval context of an ALREADY-paused, still-open gate — unlike
   * `pauseWorkflowRun`, which requires the run to currently be `'running'` and so
   * cannot be used once a pause has already landed. CAS-guarded on the gate still
   * being unresolved: a human who resolves the gate first wins the race, and this
   * returns `resolved: false` instead of clobbering their resolution.
   *
   * Built for #2707 step 3's pause escalation: a `loop_group` body gate pauses
   * generically (via `pauseWorkflowRun`, `nodeId` = the gate's own bare id), and
   * this then rewrites `nodeId` to the enclosing loop_group's id (so the
   * top-level DAG's resume walk finds it) and adds `bodyGateId` (the gate's
   * original id, otherwise lost). Pass the COMPLETE rewritten `ApprovalContext`,
   * not a partial one — the write merges into stored metadata, and an omitted
   * field can survive from the prior context on one dialect and not the other.
   */
  rewriteApprovalContext(
    id: string,
    approvalContext: ApprovalContext
  ): Promise<{ resolved: boolean }>;

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
  cancelWorkflowRun(id: string): Promise<{ cancelled: boolean }>;

  /**
   * Create a workflow event. Implementations MUST NOT throw — catch all errors
   * internally and log them. Callers treat this as observable-only: workflow
   * execution continues regardless of whether event persistence succeeds.
   */
  createWorkflowEvent(data: {
    workflow_run_id: string;
    event_type: WorkflowEventType;
    step_index?: number;
    step_name?: string;
    data?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Return completed node outputs and cumulative token usage from a prior DAG
   * workflow run. Used for resume hydration so completed nodes are skipped and
   * the run-level token tally includes every execution of the run.
   *
   * Throws on DB error — caller (executor.ts) owns the degradation policy.
   */
  getDagResumeSnapshot(workflowRunId: string): Promise<DagResumeSnapshot>;

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
  // Distinct from `AgentRequestOptions.persistSession` (Claude SDK on-disk transcript).
  getWorkflowNodeSession(key: WorkflowNodeSessionKey): Promise<WorkflowNodeSession | null>;
  upsertWorkflowNodeSession(
    params: WorkflowNodeSessionKey & {
      provider_session_id: string;
      last_run_id: string | null;
    }
  ): Promise<void>;
  deleteWorkflowNodeSessions(filter: {
    workflow_name: string;
    scope_key?: string;
    node_id?: string;
    /**
     * Optional provider filter. The executor's stale-row cleanup (run finished with
     * no sessionId) sets this so switching providers between runs doesn't clobber
     * the prior provider's saved row. Reset surfaces (CLI/chat/REST) leave it
     * undefined so a reset wipes every provider for the given scope.
     */
    provider?: string;
  }): Promise<{ deleted: number }>;
}
