import {
  DEFERRED_NODE_USAGE_EVENT_TYPE,
  type SerializedDeferredNodeUsageEvent,
  type SerializedNodeEvent,
} from '../node-record-serialization';
import {
  RUN_BUDGET_REFUSED_EVENT_TYPE,
  RUN_BUDGET_WORK_UNIT_EVENT_TYPE,
  type RunBudgetWorkUnitEvent,
} from '../run-budget';
import { TERMINAL_RUN_EVENT_TYPES } from '../schemas/workflow-run';
import { WORKTREE_SETUP_EVENT_TYPES } from '../schemas/worktree-setup';

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
  ...WORKTREE_SETUP_EVENT_TYPES,
  DEFERRED_NODE_USAGE_EVENT_TYPE,
  RUN_BUDGET_WORK_UNIT_EVENT_TYPE,
] as const;
export type DurableWorkflowEventType = (typeof DURABLE_WORKFLOW_EVENT_TYPES)[number];
export type DurableNodeEventInput =
  | NodeStateEventInput
  | SerializedDeferredNodeUsageEvent
  | RunBudgetWorkUnitEvent;

export const WORKFLOW_EVENT_TYPES = [
  'run_attention_changed',
  'attention_notice_sent',
  'workflow_started',
  ...TERMINAL_RUN_EVENT_TYPES,
  // Written for failed-run resume, engine-cancelled fan-out recovery, and resume of
  // paused or stale-running runs with a nonempty metadata.error. Optional data.error
  // preserves cleared legacy failure evidence (#2348); the event does not imply a
  // prior terminal state, and ordinary paused-run resumes use workflow_unpaused.
  'workflow_resumed',
  // The resume CAS moved a paused run back to running, with or without an answer. Every
  // resume of a paused run writes it, so a pause that closes reaches the event feed.
  'workflow_unpaused',
  // Between-run continuation (#2747) — written on the ADOPTING run's log when it
  // starts with `--adopt`/`--supersedes`, so the chain renders from events alone.
  'workflow.run_adopted',
  // Fan-out siblings that shared one checkout (#2777); one row per sibling.
  'workflow.checkout_shared',
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
  // A paused run's inline notice could not be delivered. The run stays paused; the
  // attention queue is where it is answered. `data` carries `nodeId`, `platform` and the
  // pause `occurrence` (absent on events from before it was recorded), which the push router matches.
  'pause_notice_undelivered',
  'wait_started',
  // A resumed run paused again at the same wait, which has not fired or been answered:
  // `data.kind` is the wait kind. Without it a resume that re-pauses would reach no reader.
  'wait_continued',
  'wait_signaled',
  // An attention wait's answer: `data` carries the surface (`via`), the occurrence it
  // answered and the answer itself; the row's timestamp is when.
  'wait_answered',
  // A label write on an open attention wait: `data` carries the surface (`via`), the
  // occurrence, the keys set and unset, and the revision it produced; the row's
  // timestamp is when.
  'attention_labeled',
  'wait_completed',
  'wait_expired',
  'quota_resume_scheduled',
  'quota_resume_triggered',
  'quota_resume_exhausted',
  'quota_resume_skipped',
  // #4209 — this host could not read the run's frozen source for a node, so the run was
  // paused instead of failed. `data` carries `node_id`, `path` (when known), `error` and
  // `retry_at`; any host that can read the source continues it.
  'source_released',
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
  // #2814 — the run budget refused new work, or a spend-limited run's spend could
  // not be measured. `data` carries the reason, refused node, limits and consumption.
  RUN_BUDGET_REFUSED_EVENT_TYPE,
  // #2213 — keys the engine dropped from this run's workflow YAML. Written by the
  // executor at run start for EVERY run that has them, whatever surface started
  // it, so the record does not depend on a chat/console notification being
  // deliverable. `data.warnings` is the message list. Absence means the YAML was
  // clean OR the run predates this event type — never that delivery failed.
  'workflow_parse_warnings',
  // #5185 — a credential check at run start could not decide, and the run started
  // anyway. `data` carries `provider`, optional `vendor`, `source` and the check's
  // `evidence`. Absence means every check decided OR the run predates this event type.
  'credential_check_inconclusive',
  'workflow_cleanup_warning',
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
 * The event a gate pause commits with its write, so the pause reaches the event feed: the
 * gate node's `node_suspended`, or the container write-back gate's `writeback_requested`.
 */
export type GatePauseEventInput = NodeStateEventInput | WorkflowEventInput<'writeback_requested'>;

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
