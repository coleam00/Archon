import type { RunStatus } from '../lib/run-status';

export type RunOrigin = 'web' | 'cli' | 'slack' | 'telegram' | 'discord' | 'github' | 'unknown';

export interface Run {
  id: string;
  projectId: string | null;
  projectName: string | null;
  /** Total USD cost from the agent SDK. Populated for completed Claude runs;
   *  Pi/Codex runs may not report cost. Null when the run hasn't recorded any. */
  costUsd: number | null;
  /** DB id of the conversation this run belongs to. */
  conversationId: string | null;
  /**
   * Platform-level conversation id (e.g. `cli-1776237248436-q61o4h`). This is
   * the id the `/api/conversations/:id/messages` route accepts in its URL
   * path — the server looks conversations up by platform id, not DB id, on
   * that endpoint. Use this when fetching the run's messages.
   */
  conversationPlatformId: string | null;
  /**
   * Platform id of the WORKER conversation for chat-dispatched (web) runs —
   * where a chat-dispatched run's messages actually live. See
   * runMessageConversationId() for how CLI vs. web runs are picked (#2048).
   */
  workerPlatformId: string | null;
  workflow: string;
  origin: RunOrigin;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  /** workflow_runs.working_path — used to join against worktrees. */
  workingPath: string | null;
  userMessage: string;
  /** Derived from metadata/events at runtime; initially undefined. */
  currentNode?: string | null;
  lastTool?: string | null;
  /**
   * Pending human gate. Null once the gate is resolved (see gateResolved).
   * `completionSignaled` is true when an interactive-loop gate paused on an
   * iteration that emitted its completion signal (#2074) — a bare approve
   * finalizes the node (no re-run); a comment runs another iteration.
   */
  approval?: { nodeId: string; message: string; completionSignaled: boolean } | null;
  /**
   * Set when a paused run's gate was already approved/rejected and the run is
   * only awaiting auto-resume (server: metadata.approval.resolved). The
   * approval surfaces hide (approval is null) and the card shows a
   * "resuming" hint instead of stale approve/reject buttons.
   */
  gateResolved?: 'approved' | 'rejected' | null;
  /**
   * Run-tree parent (#2121 Phase 2). Set when this run is a `workflow:` sub-run
   * spawned by a parent run's node; null for top-level runs. Drives the "child of"
   * affordance in the console so a sub-run isn't mistaken for an orphan top-level run.
   */
  parentRunId?: string | null;
}

// Server shapes we read from. These track the real server schema loosely —
// fields we don't use are omitted. The normalizer defends against missing
// optional fields.

interface RawWorkflowRun {
  id: string;
  workflow_name: string;
  codebase_id: string | null;
  conversation_id?: string | null;
  /** Platform-level conversation id — exposed on the getRun response only. */
  conversation_platform_id?: string | null;
  /** Worker conversation platform id — getRun response only, web runs only. */
  worker_platform_id?: string | null;
  status: string;
  started_at: string;
  completed_at?: string | null;
  working_path?: string | null;
  user_message?: string;
  metadata?: Record<string, unknown>;
  /** Only present on dashboard runs — enriched by server-side join. */
  codebase_name?: string | null;
  platform_type?: string | null;
  current_step_name?: string | null;
  /** Run-tree parent id (#2121 Phase 2); null/absent for top-level runs. */
  parent_run_id?: string | null;
}

const KNOWN_STATUSES: readonly RunStatus[] = [
  'running',
  'paused',
  'failed',
  'completed',
  'cancelled',
];

function normalizeStatus(s: string): RunStatus {
  // Treat 'pending' as 'running' for UI purposes — it's transient.
  if (s === 'pending') return 'running';
  return (KNOWN_STATUSES as readonly string[]).includes(s) ? (s as RunStatus) : 'running';
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

function readCost(meta: Record<string, unknown> | undefined): number | null {
  if (meta === undefined) return null;
  const raw = meta.total_cost_usd;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
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

export function toRun(raw: RawWorkflowRun): Run {
  const approval = raw.metadata?.approval;
  const isApprovalShape =
    approval !== null &&
    typeof approval === 'object' &&
    approval !== undefined &&
    'nodeId' in approval &&
    typeof (approval as { nodeId: unknown }).nodeId === 'string';
  // A resolved gate (approved/rejected, run paused only while awaiting
  // auto-resume — see ApprovalContext.resolved on the server) is NOT a
  // pending approval: surface it via gateResolved instead so approve/reject
  // buttons never render for an already-resolved gate.
  const resolvedRaw = isApprovalShape ? (approval as { resolved?: unknown }).resolved : undefined;
  const gateResolved =
    resolvedRaw === 'approved' || resolvedRaw === 'rejected' ? resolvedRaw : null;
  const parsedApproval =
    isApprovalShape && gateResolved === null
      ? {
          nodeId: (approval as { nodeId: string }).nodeId,
          message:
            'message' in approval && typeof (approval as { message: unknown }).message === 'string'
              ? (approval as { message: string }).message
              : '',
          completionSignaled:
            (approval as { completionSignaled?: unknown }).completionSignaled === true,
        }
      : null;

  return {
    id: raw.id,
    projectId: raw.codebase_id,
    projectName: raw.codebase_name ?? null,
    costUsd: readCost(raw.metadata),
    conversationId: raw.conversation_id ?? null,
    conversationPlatformId: raw.conversation_platform_id ?? null,
    workerPlatformId: raw.worker_platform_id ?? null,
    workflow: raw.workflow_name,
    origin: normalizeOrigin(raw.platform_type),
    status: normalizeStatus(raw.status),
    startedAt: raw.started_at,
    finishedAt: raw.completed_at ?? null,
    workingPath: raw.working_path ?? null,
    userMessage: raw.user_message ?? '',
    currentNode: raw.current_step_name ?? null,
    lastTool: null,
    approval: parsedApproval,
    gateResolved,
    parentRunId: raw.parent_run_id ?? null,
  };
}
