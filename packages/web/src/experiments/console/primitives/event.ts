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
  /** Only populated for `skipped` — `when_condition` or `trigger_rule`. */
  skipReason: string | null;
  /** Only populated for `skipped` — the evaluated expression that gated it. */
  skipExpr: string | null;
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
    et === 'node_skipped'
  ) {
    const transition = et.replace('node_', '') as 'started' | 'completed' | 'failed' | 'skipped';
    return {
      ...base,
      kind: 'node_transition',
      nodeName: readString(data, 'name') || (raw.step_name ?? ''),
      transition,
      durationMs: readNumberOrNull(data, 'duration'),
      skipReason: transition === 'skipped' ? readStringOrNull(data, 'reason') : null,
      skipExpr: transition === 'skipped' ? readStringOrNull(data, 'expr') : null,
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

  if (et === 'approval_pending' || et === 'approval_resolved') {
    const resolution = et === 'approval_resolved';
    const resolvedAs = readString(data, 'resolution'); // 'approved' | 'rejected'
    return {
      ...base,
      kind: 'approval',
      prompt: readString(data, 'message'),
      resolution: resolution
        ? resolvedAs === 'rejected'
          ? {
              kind: 'rejected',
              at: raw.created_at,
              reason: readString(data, 'reason'),
            }
          : {
              kind: 'approved',
              at: raw.created_at,
              comment: readStringOrNull(data, 'comment'),
            }
        : null,
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
