import type { QueryParams } from '../lib/api-types';
import type { RunStatus } from '../lib/run-status';
import type { components } from '@/lib/api.generated';

export type RunOrigin = 'web' | 'cli' | 'slack' | 'telegram' | 'discord' | 'github' | 'unknown';
/** How a run completed: `succeeded` or `failed` for the boolean form, or a named outcome. */
export type RunOutcome = components['schemas']['WorkflowRun']['completed_outcome'];
type WorkflowRunMetadata = components['schemas']['WorkflowRunMetadata'];
type WorkflowApproval = NonNullable<WorkflowRunMetadata['approval']>;
type WorkflowWait = NonNullable<WorkflowRunMetadata['wait']>;
type WorkflowRunStopReason = NonNullable<WorkflowRunMetadata['stop_reason']>;
type WorkflowWaitOwnerField =
  | 'owner'
  | 'nodeId'
  | 'bodyWaitId'
  | 'iteration'
  | 'sessionId'
  | 'sessionProvider';
type NormalizedWorkflowWait<T extends WorkflowWait = WorkflowWait> = T extends WorkflowWait
  ? Omit<T, WorkflowWaitOwnerField> & { nodeId: string }
  : never;

export interface Run {
  id: WorkflowRun['id'];
  projectId: WorkflowRun['codebase_id'];
  projectName: components['schemas']['DashboardWorkflowRun']['codebase_name'];
  /** Total USD cost from the agent SDK. Populated for completed Claude runs;
   *  Pi/Codex runs may not report cost. Null when the run hasn't recorded any. */
  costUsd: number | null;
  /** DB id of the conversation this run belongs to. */
  conversationId: WorkflowRun['conversation_id'];
  /**
   * Platform-level conversation id (e.g. `cli-1776237248436-9f86d081884c7d659a2feaa0c55ad015`). This is
   * the id the `/api/conversations/:id/messages` route accepts in its URL
   * path — the server looks conversations up by platform id, not DB id, on
   * that endpoint. Use this when fetching the run's messages.
   */
  conversationPlatformId: DetailRun['conversation_platform_id'];
  /**
   * Platform id of the WORKER conversation for chat-dispatched (web) runs —
   * where a chat-dispatched run's messages actually live. See
   * runMessageConversationId() for how CLI vs. web runs are picked (#2048).
   */
  workerPlatformId: components['schemas']['DashboardWorkflowRun']['worker_platform_id'];
  workflow: WorkflowRun['workflow_name'];
  origin: RunOrigin;
  status: RunStatus;
  /**
   * What the server observes about a running run's execution owner. Null or absent when it
   * makes no claim: the run is not running, or the payload carries no observation.
   */
  ownerObservation?: components['schemas']['DashboardWorkflowRun']['owner_observation'];
  attention: components['schemas']['WorkflowRun']['attention'];
  /** An operator's pause, requested or in effect; null or absent otherwise. */
  operatorPause?: components['schemas']['WorkflowRun']['operator_pause'];
  outcome: RunOutcome;
  terminalRecord: components['schemas']['WorkflowRunDetail']['run']['terminal_record'];
  startedAt: WorkflowRun['started_at'];
  /**
   * When the run's current execution phase began: set each time a resume or an answer
   * continues the run, null for a run that has only its first phase.
   */
  activePhaseStartedAt?: WorkflowRun['active_phase_started_at'];
  finishedAt: WorkflowRun['completed_at'];
  /** workflow_runs.working_path — used to join against worktrees. */
  workingPath: WorkflowRun['working_path'];
  userMessage: NonNullable<WorkflowRun['user_message']>;
  activeNodes: NonNullable<components['schemas']['DashboardWorkflowRun']['active_nodes']>;
  lastTool?: string | null;
  toolCallAttention?: NonNullable<WorkflowRunMetadata['tool_call_attention']>;
  /**
   * Pending human gate. Null once the gate is resolved (see gateResolved).
   * `completionSignaled` is true when an interactive-loop gate paused on an
   * iteration that emitted its completion signal (#2074) — a bare approve
   * finalizes the node (no re-run); a comment runs another iteration.
   * `decisions`/`decisionsAuthored` (#2707 step 2) are the gate's declared
   * decision vocabulary, snapshotted at pause time — always populated
   * (default `approve`/`reject` pair when the author wrote none explicitly);
   * `decisionsAuthored` is the signal that the author declared a vocabulary
   * beyond the default pair.
   */
  approval?: {
    nodeId: string;
    pauseId?: WorkflowApproval['pauseId'];
    message: string;
    completionSignaled: boolean;
    decisions: NonNullable<WorkflowApproval['decisions']>;
    decisionsAuthored: boolean;
  } | null;
  /** Active durable wait cursor. Mutually exclusive with approval metadata. */
  wait?: NormalizedWorkflowWait | null;
  /**
   * Set when a paused run's gate was already approved/rejected and the run is
   * only awaiting auto-resume (server: metadata.approval.resolved). The
   * approval surfaces hide (approval is null) and the card shows a
   * "resuming" hint instead of stale approve/reject buttons.
   */
  gateResolved?: WorkflowApproval['resolved'];
  /**
   * Why the run stopped, as the owning process recorded it (#3479). Null when it
   * stopped without one, or has not stopped. The run's `status` is unaffected: a
   * run interrupted by a signal is still `failed`, and still resumable.
   */
  stopReason?: WorkflowRunStopReason | null;
  /**
   * Run-tree parent (#2121 Phase 2). Set when this run is a `workflow:` sub-run
   * spawned by a parent run's node; null for top-level runs. Drives the "child of"
   * affordance in the console so a sub-run isn't mistaken for an orphan top-level run.
   */
  parentRunId?: WorkflowRun['parent_run_id'];
}

/**
 * When the run last began executing: its latest phase start, or its creation when it
 * has had only one phase. A resumed run keeps its creation time as `startedAt`, so
 * measuring a duration from there would count the time it sat failed or paused.
 */
export function runPhaseStart(run: Pick<Run, 'startedAt' | 'activePhaseStartedAt'>): string {
  return run.activePhaseStartedAt ?? run.startedAt;
}

export function runDetailPath(run: Pick<Run, 'id' | 'projectId'>): string {
  const runId = encodeURIComponent(run.id);
  return run.projectId === null
    ? `/console/r/${runId}`
    : `/console/p/${encodeURIComponent(run.projectId)}/r/${runId}`;
}

type WorkflowRun = components['schemas']['WorkflowRun'];
type DashboardWorkflowRun = components['schemas']['DashboardWorkflowRun'];
type DetailRun = components['schemas']['WorkflowRunDetail']['run'];
type RawWorkflowRun = Pick<
  WorkflowRun,
  'id' | 'workflow_name' | 'codebase_id' | 'status' | 'started_at'
> &
  Partial<
    Pick<
      WorkflowRun,
      | 'conversation_id'
      | 'outcome'
      | 'completed_outcome'
      | 'completed_at'
      | 'active_phase_started_at'
      | 'working_path'
      | 'user_message'
      | 'metadata'
      | 'attention'
      | 'operator_pause'
      | 'parent_run_id'
    >
  > &
  Partial<
    Pick<
      DashboardWorkflowRun,
      | 'codebase_name'
      | 'platform_type'
      | 'active_nodes'
      | 'worker_platform_id'
      | 'owner_observation'
    >
  > &
  Partial<Pick<DetailRun, 'conversation_platform_id' | 'terminal_record'>>;

function normalizeStatus(status: WorkflowRun['status']): RunStatus {
  return status === 'pending' ? 'running' : status;
}

function normalizeWorkflowWait(wait: WorkflowWait): NormalizedWorkflowWait {
  if (wait.owner === 'node') {
    const { owner, ...normalized } = wait;
    void owner;
    return normalized;
  }
  const { owner, nodeId, bodyWaitId, iteration, sessionId, sessionProvider, ...normalized } = wait;
  void owner;
  void iteration;
  void sessionId;
  void sessionProvider;
  return { ...normalized, nodeId: `${nodeId}.${bodyWaitId}` };
}

export function normalizeOrigin(s: string | null | undefined): RunOrigin {
  if (s === null || s === undefined) return 'unknown';
  const lower = s.toLowerCase();
  switch (lower) {
    case 'web':
    case 'cli':
    case 'slack':
    case 'telegram':
    case 'discord':
    case 'github':
      return lower;
    default:
      return 'unknown';
  }
}

function readCost(meta: WorkflowRunMetadata | undefined): number | null {
  if (meta === undefined) return null;
  const raw = meta.total_cost_usd;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * The platform conversation id that holds this run's messages — the id the
 * `/api/conversations/:id/messages` route accepts. CLI runs expose it as
 * `conversationPlatformId`; chat-dispatched (web) runs only expose the worker
 * conversation as `workerPlatformId`, which is where their agent output is
 * persisted (#2048). Null for list-sourced rows (neither field is present)
 * and for a run that hasn't loaded yet, so message fetching stays off there.
 */
export function runMessageConversationId(run: Run | undefined): string | null {
  if (run === undefined) return null;
  return run.conversationPlatformId ?? run.workerPlatformId;
}

function readApproval(approval: WorkflowApproval | undefined): Run['approval'] {
  return approval !== undefined && (approval.resolved ?? null) === null
    ? {
        nodeId: approval.nodeId,
        pauseId: approval.pauseId,
        message:
          approval.type === 'child_workflow'
            ? approval.childRunId
              ? `Waiting on sub-run ${approval.childRunId}. Review the child run to continue.`
              : 'Waiting on a sub-run. Review the child run to continue.'
            : approval.message,
        completionSignaled: approval.completionSignaled === true,
        decisions: approval.decisions ?? [],
        decisionsAuthored: approval.decisionsAuthored === true,
      }
    : null;
}

function readRunProvenance(raw: RawWorkflowRun) {
  return {
    projectId: raw.codebase_id,
    projectName: raw.codebase_name ?? null,
    conversationId: raw.conversation_id ?? null,
    conversationPlatformId: raw.conversation_platform_id ?? null,
    workerPlatformId: raw.worker_platform_id ?? null,
    origin: normalizeOrigin(raw.platform_type),
    parentRunId: raw.parent_run_id ?? null,
  };
}

/**
 * The rule `displayedRunOutcome` in @archon/workflows owns: a run completed by a binary
 * from before `completed_outcome` has only `outcome`, and a run that did not complete
 * shows none, though an older binary may have written `outcome` while it ran. The console
 * cannot import the engine; `scripts/run-outcome-parity.test.ts` holds the two equal.
 */
export function readOutcome(
  raw: Pick<RawWorkflowRun, 'status' | 'outcome' | 'completed_outcome'>
): RunOutcome {
  return raw.completed_outcome ?? (raw.status === 'completed' ? (raw.outcome ?? null) : null);
}

/** The gate or wait the run is paused at; a gate or wait beside an operator pause is history. */
function readCurrentPause(raw: RawWorkflowRun): Pick<Run, 'approval' | 'wait' | 'gateResolved'> {
  if (raw.operator_pause?.state === 'paused')
    return { approval: null, wait: null, gateResolved: null };
  const wait = raw.metadata?.wait;
  const parsedWait: NormalizedWorkflowWait | null =
    wait === undefined ? null : normalizeWorkflowWait(wait);
  return {
    approval: parsedWait === null ? readApproval(raw.metadata?.approval) : null,
    wait: parsedWait,
    gateResolved: raw.metadata?.approval?.resolved ?? null,
  };
}

export function toRun(raw: RawWorkflowRun): Run {
  const activeNodes = Array.isArray(raw.active_nodes)
    ? raw.active_nodes.filter(nodeId => typeof nodeId === 'string' && nodeId.length > 0)
    : [];

  return {
    ...readRunProvenance(raw),
    id: raw.id,
    costUsd: readCost(raw.metadata),
    workflow: raw.workflow_name,
    status: normalizeStatus(raw.status),
    ownerObservation: raw.owner_observation,
    attention: raw.attention ?? null,
    operatorPause: raw.operator_pause ?? null,
    outcome: readOutcome(raw),
    terminalRecord: raw.terminal_record ?? null,
    startedAt: raw.started_at,
    activePhaseStartedAt: raw.active_phase_started_at ?? null,
    finishedAt: raw.completed_at ?? null,
    workingPath: raw.working_path ?? null,
    userMessage: raw.user_message ?? '',
    activeNodes,
    lastTool: null,
    toolCallAttention: raw.status === 'running' ? (raw.metadata?.tool_call_attention ?? []) : [],
    ...readCurrentPause(raw),
    stopReason: raw.metadata?.stop_reason ?? null,
  };
}

export interface ListRunsOptions {
  codebaseId?: QueryParams<'/api/dashboard/runs', 'get'>['codebaseId'];
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

type AttentionResponse = components['schemas']['RunsNeedingAttentionResponse'];
type AttentionQueueItem = components['schemas']['AttentionQueueItem'];

/** An ask a completed run left on its item: an attention item no run holds. */
export type ItemAsk = Extract<AttentionQueueItem, { kind: 'attention' }> & { run?: undefined };

export function isItemAsk(item: AttentionQueueItem): item is ItemAsk {
  return item.kind === 'attention' && item.run === undefined;
}

/**
 * A run that holds its item while its owner is gone (the queue's `owner_lost` item): later
 * starts of its workflow on the item wait behind it until the operator resumes or abandons it.
 */
export interface OwnerLostHolder {
  runId: string;
  workflow: string;
  projectId: string | null;
  projectName: string | null;
  /** The item's key; null when the item could not be read. */
  itemKey: string | null;
  /** The run's stored status, unchanged: the engine never ends it by itself. */
  observedStatus: Extract<AttentionQueueItem, { kind: 'owner_lost' }>['observedStatus'];
}

export interface RunsAttention {
  runs: Run[];
  ownerLost: OwnerLostHolder[];
  asks: ItemAsk[];
  /** Each listed ref the caller may not answer, with the server's reason. */
  answerRefusals: AttentionResponse['answerRefusals'];
  /** The id of every item the list holds open, whether a run or an ask holds it. */
  itemIds: ReadonlySet<string>;
  degraded: NonNullable<AttentionResponse['degraded']>;
}

export function toOwnerLostHolders(items: AttentionQueueItem[]): OwnerLostHolder[] {
  return items.flatMap(item =>
    item.kind === 'owner_lost'
      ? [
          {
            runId: item.run.id,
            workflow: item.run.workflow,
            projectId: item.project?.codebaseId ?? null,
            projectName: item.project?.name ?? null,
            itemKey: item.item?.key ?? null,
            observedStatus: item.observedStatus,
          },
        ]
      : []
  );
}
