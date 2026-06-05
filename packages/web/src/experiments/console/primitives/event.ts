/**
 * Run event stream primitives. Six variants of events that render in the Run
 * detail page: text, tool_call, artifact, node_transition, approval, error.
 *
 * These are the client-side model — normalized from server workflow_events
 * rows AND from SSE events. The shape is deliberately flatter than the raw
 * event schema so EventStream rendering can switch on `kind` only.
 */

export type RunEventKind =
  | 'text'
  | 'tool_call'
  | 'artifact'
  | 'node_transition'
  | 'approval'
  | 'error'
  | 'system';

interface RunEventBase {
  id: string;
  runId: string;
  kind: RunEventKind;
  timestamp: string;
  nodeId: string | null;
}

export interface TextEvent extends RunEventBase {
  kind: 'text';
  content: string;
}

export interface ToolCallEvent extends RunEventBase {
  kind: 'tool_call';
  tool: string;
  argsSummary: string;
  args: unknown;
  result: { ok: true; durationMs: number } | { ok: false; message: string } | null;
}

export interface ArtifactEvent extends RunEventBase {
  kind: 'artifact';
  artifactType: string;
  label: string;
  url: string | null;
  path: string | null;
}

export interface NodeTransitionEvent extends RunEventBase {
  kind: 'node_transition';
  nodeName: string;
  transition: 'started' | 'completed' | 'failed' | 'skipped';
  durationMs: number | null;
  /** Only populated for `skipped` — the server's skip reason (e.g. `when_condition`, `trigger_rule`, `prior_success`). */
  skipReason: string | null;
  /** Only populated for `skipped` — the evaluated expression that gated it. */
  skipExpr: string | null;
  /**
   * `node_completed` enrichment, read straight from the persisted event payload.
   * Populated only on the `completed` transition; null on every other transition
   * (and when a provider doesn't report a given field). Not consumed by any current
   * renderer — carried so the eventual per-node detail view needn't re-touch this.
   */
  outputPreview: string | null;
  costUsd: number | null;
  stopReason: string | null;
  numTurns: number | null;
}

export interface ApprovalEvent extends RunEventBase {
  kind: 'approval';
  prompt: string;
  resolution:
    | { kind: 'approved'; at: string; comment: string | null }
    | { kind: 'rejected'; at: string; reason: string }
    | null;
}

export interface ErrorEvent extends RunEventBase {
  kind: 'error';
  message: string;
  recoverable: boolean;
}

/**
 * Workflow-lifecycle events: `workflow_started`, `workflow_completed`,
 * `workflow_failed`, and any other framework-level signals worth surfacing
 * behind the "System" toggle. These don't belong in the user/agent thread
 * but are useful when diagnosing a run.
 */
export interface SystemEvent extends RunEventBase {
  kind: 'system';
  label: string;
  detail: string;
}

export type RunEvent =
  | TextEvent
  | ToolCallEvent
  | ArtifactEvent
  | NodeTransitionEvent
  | ApprovalEvent
  | ErrorEvent
  | SystemEvent;

// Server row shape (workflow_events table).
interface RawWorkflowEvent {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

function readString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function readStringOrNull(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function readNumberOrNull(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' ? v : null;
}

/**
 * DB node-event `event_type` → UI transition. Listed explicitly (rather than
 * string-slicing `node_<x>`) because `node_skipped_prior_success` — emitted on
 * resume for already-completed nodes — doesn't fit that shape, and both skip
 * variants collapse to `skipped`.
 */
const NODE_TRANSITION_BY_EVENT: Record<string, NodeTransitionEvent['transition']> = {
  node_started: 'started',
  node_completed: 'completed',
  node_failed: 'failed',
  node_skipped: 'skipped',
  node_skipped_prior_success: 'skipped',
};

/**
 * Best-effort normalizer from a raw workflow_events row to a typed RunEvent.
 * Unknown event types fall through as text events with the raw payload —
 * the spike surfaces them rather than silently dropping.
 */
export function toRunEvent(raw: RawWorkflowEvent): RunEvent {
  const base = {
    id: raw.id,
    runId: raw.workflow_run_id,
    timestamp: raw.created_at,
    nodeId: raw.step_name,
  };
  const data = raw.data;
  const et = raw.event_type;

  if (
    et === 'node_started' ||
    et === 'node_completed' ||
    et === 'node_failed' ||
    et === 'node_skipped' ||
    et === 'node_skipped_prior_success'
  ) {
    // Guard above restricts `et` to the map's keys; `?? 'skipped'` is only a
    // defensive default if a new node_* type is added to the guard but not the map.
    const transition = NODE_TRANSITION_BY_EVENT[et] ?? 'skipped';
    const output = readStringOrNull(data, 'node_output');
    return {
      ...base,
      kind: 'node_transition',
      nodeName: readString(data, 'name') || (raw.step_name ?? ''),
      transition,
      // Server persists `duration_ms` (NOT `duration`); reading the wrong key here
      // left every node duration null in the UI.
      durationMs: readNumberOrNull(data, 'duration_ms'),
      skipReason: transition === 'skipped' ? readStringOrNull(data, 'reason') : null,
      skipExpr: transition === 'skipped' ? readStringOrNull(data, 'expr') : null,
      outputPreview: output === null ? null : output.slice(0, 300),
      costUsd: readNumberOrNull(data, 'cost_usd'),
      stopReason: readStringOrNull(data, 'stop_reason'),
      numTurns: readNumberOrNull(data, 'num_turns'),
    };
  }

  if (et === 'tool_called' || et === 'tool_completed') {
    // Server writes snake_case fields (tool_name, tool_input, duration_ms);
    // the start event carries the input, the completed event carries only
    // the duration. RunStream pairs them by step + order to fill durationMs.
    const toolName = readString(data, 'tool_name');
    const toolInput = data.tool_input;
    const argsSummary = readString(data, 'argsSummary');
    return {
      ...base,
      kind: 'tool_call',
      tool: toolName,
      argsSummary,
      args: toolInput,
      result:
        et === 'tool_called'
          ? null
          : { ok: true, durationMs: readNumberOrNull(data, 'duration_ms') ?? 0 },
    };
  }

  if (et === 'workflow_artifact') {
    return {
      ...base,
      kind: 'artifact',
      artifactType: readString(data, 'artifactType'),
      label: readString(data, 'label'),
      url: readStringOrNull(data, 'url'),
      path: readStringOrNull(data, 'path'),
    };
  }

  // The server writes two rows around a human gate: `approval_requested` (carries
  // the prompt in `message`) and `approval_received` (carries the outcome in
  // `decision` + `comment`/`reason`). The prompt does NOT ride the received row;
  // these two are emitted as separate events and a future renderer would pair them
  // by nodeId. (Today nothing renders `approval` events in the run stream — paused
  // gates are driven from `run.approval` metadata — so this is correctness of
  // classification, not display.) The old code checked `approval_pending`/
  // `approval_resolved` and read a `resolution` key, none of which the server ever
  // writes, so approvals fell through to the raw-JSON fallback below.
  if (et === 'approval_requested') {
    return {
      ...base,
      kind: 'approval',
      prompt: readString(data, 'message'),
      resolution: null,
    };
  }

  if (et === 'approval_received') {
    const decision = readString(data, 'decision');
    // Match the decision explicitly. An unknown/missing value must NOT default to
    // "approved" (that would silently render a rejected gate as approved — the exact
    // silent-mismatch class this normalizer exists to prevent); leave it unresolved.
    const resolution: ApprovalEvent['resolution'] =
      decision === 'approved'
        ? { kind: 'approved', at: raw.created_at, comment: readStringOrNull(data, 'comment') }
        : decision === 'rejected'
          ? { kind: 'rejected', at: raw.created_at, reason: readString(data, 'reason') }
          : null;
    return {
      ...base,
      kind: 'approval',
      prompt: '',
      resolution,
    };
  }

  if (et === 'error') {
    return {
      ...base,
      kind: 'error',
      message: readString(data, 'error') || readString(data, 'message'),
      recoverable: Boolean(data.recoverable),
    };
  }

  if (et === 'workflow_started' || et === 'workflow_completed' || et === 'workflow_failed') {
    const label =
      et === 'workflow_started'
        ? 'Workflow started'
        : et === 'workflow_completed'
          ? 'Workflow completed'
          : 'Workflow failed';
    const detail =
      readString(data, 'name') ||
      readString(data, 'workflow') ||
      readString(data, 'message') ||
      readString(data, 'error');
    return {
      ...base,
      kind: 'system',
      label,
      detail,
    };
  }

  // Fallback: render anything else as a text event with the payload summary.
  return {
    ...base,
    kind: 'text',
    content:
      readString(data, 'text') ||
      readString(data, 'message') ||
      `${et} — ${JSON.stringify(data).slice(0, 200)}`,
  };
}
