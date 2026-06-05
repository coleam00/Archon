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
  approval?: { nodeId: string; message: string } | null;
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

export function toRun(raw: RawWorkflowRun): Run {
  const approval = raw.metadata?.approval;
  const parsedApproval =
    approval !== null &&
    typeof approval === 'object' &&
    approval !== undefined &&
    'nodeId' in approval &&
    typeof (approval as { nodeId: unknown }).nodeId === 'string'
      ? {
          nodeId: (approval as { nodeId: string }).nodeId,
          message:
            'message' in approval && typeof (approval as { message: unknown }).message === 'string'
              ? (approval as { message: string }).message
              : '',
        }
      : null;

  return {
    id: raw.id,
    projectId: raw.codebase_id,
    projectName: raw.codebase_name ?? null,
    costUsd: readCost(raw.metadata),
    conversationId: raw.conversation_id ?? null,
    conversationPlatformId: raw.conversation_platform_id ?? null,
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
  };
}
