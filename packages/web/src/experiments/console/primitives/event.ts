/**
 * Run event stream primitives. Six variants of events that render in the Run
 * detail page: text, tool_call, artifact, node_transition, approval, error.
 *
 * These are the client-side model — normalized from server workflow_events
 * rows AND from SSE events. The shape is deliberately flatter than the raw
 * event schema so EventStream rendering can switch on `kind` only.
 */

import type { components } from '@/lib/api.generated';

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

  if (et === 'integration_operation') {
    const result = data.result;
    const ok =
      typeof result === 'object' && result !== null && 'ok' in result && result.ok === true;
    const error =
      typeof result === 'object' && result !== null && 'error' in result ? result.error : null;
    const message =
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
        ? error.message
        : 'Integration operation failed';
    return {
      ...base,
      kind: 'tool_call',
      tool: `${readString(data, 'integration')}.${readString(data, 'operation')}`,
      argsSummary: JSON.stringify(data.target ?? null),
      args: { operationId: data.operationId, target: data.target, plugin: data.plugin, result },
      result: ok
        ? { ok: true, durationMs: readNumberOrNull(data, 'durationMs') ?? 0 }
        : { ok: false, message },
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

  if (
    et === 'workflow_started' ||
    et === 'workflow_completed' ||
    et === 'workflow_failed' ||
    et === 'workflow_resumed'
  ) {
    // `workflow_resumed` is written only when a resume CLEARED a prior error
    // (#2348), and carries that error in `data.error` — the same key
    // `workflow_failed` uses, so the shared `detail` fallback below surfaces it.
    const label =
      et === 'workflow_started'
        ? 'Workflow started'
        : et === 'workflow_completed'
          ? 'Workflow completed'
          : et === 'workflow_resumed'
            ? 'Workflow resumed (prior error cleared)'
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

  // Container isolation lifecycle (folder-project container runs). Persisted with
  // DB-side names, NOT the emitter's `container_lifecycle` type — this normalizer
  // reads DB rows. Surfaced behind the System toggle. created/destroyed bracket the
  // run; stopped/resumed bracket a suspend across a pause; writeback_* track the
  // write-back gate (Phase C).
  const CONTAINER_EVENT_LABELS: Record<string, string> = {
    container_created: 'Container created',
    container_stopped: 'Container stopped (paused)',
    container_resumed: 'Container resumed',
    container_destroyed: 'Container removed',
    writeback_requested: 'Write-back requested',
    writeback_applied: 'Changes applied to live folder',
    writeback_discarded: 'Changes discarded',
  };
  if (et in CONTAINER_EVENT_LABELS) {
    const containerId = readString(data, 'containerId');
    let detail = containerId ? containerId.slice(0, 12) : '';
    if (et === 'writeback_applied') {
      const filesApplied = readNumberOrNull(data, 'files_applied') ?? 0;
      const filesDeleted = readNumberOrNull(data, 'files_deleted') ?? 0;
      detail = `${filesApplied} written, ${filesDeleted} deleted`;
    } else if (et === 'writeback_requested') {
      const totalCount = readNumberOrNull(data, 'total_count');
      detail = totalCount !== null ? `${totalCount} file(s) changed` : '';
    }
    return {
      ...base,
      kind: 'system',
      label: CONTAINER_EVENT_LABELS[et] ?? et,
      detail,
    };
  }

  // Keys the engine dropped from this run's YAML (#2213). Mapped explicitly —
  // the fallback below would render the raw `{"warnings":[…]}` payload. Rendered
  // as `text`, NOT `system`: system rows sit behind the System toggle (off by
  // default), and a silently dropped `interactive:` gate is exactly what the
  // author needs to see without opting in.
  if (et === 'workflow_parse_warnings') {
    const warnings = Array.isArray(data.warnings)
      ? data.warnings.filter((w): w is string => typeof w === 'string')
      : [];
    return {
      ...base,
      kind: 'text',
      content:
        warnings.length > 0
          ? `⚠️ This workflow declares keys the engine ignores:\n${warnings.map(w => `- ${w}`).join('\n')}`
          : '⚠️ This workflow declares keys the engine ignores.',
    };
  }

  // Deprecated bundled default (#2781). Mapped explicitly — the fallback would
  // render the raw `{"workflowName":…,"notice":…}` payload, truncating away the
  // escape-hatch sentence. Rendered as `text`, NOT `system`: the notice tells the
  // user what to do (copy the workflow file out of the pack) and must be visible
  // without opting into the System toggle.
  if (et === 'workflow_deprecation_notice') {
    const notice = readString(data, 'notice');
    return {
      ...base,
      kind: 'text',
      content: notice || '⚠️ This workflow is deprecated.',
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

/** The engine's state for one node, served as `run.nodes` on the run-detail response. */
export type RunNodeState = components['schemas']['WorkflowRunDetail']['run']['nodes'][number];

/**
 * One node's display record: its `node_transition` events grouped under the
 * engine's state for it, so the run stream renders one divider per node
 * instead of one per raw transition.
 */
export interface NodeRun {
  /** `step_name`, the engine's `node_id`. */
  nodeId: string;
  nodeName: string;
  status: RunNodeState['state'];
  /** Earliest transition timestamp — positions the single divider in the stream. */
  startedAt: string;
  /** Timestamp of the transition that produced `status`; null while running or pending. */
  endedAt: string | null;
  durationMs: number | null;
  /** Written by the engine only on `node_completed`; null for non-AI nodes and any non-completed terminal. */
  costUsd: number | null;
  numTurns: number | null;
  stopReason: string | null;
  skipReason: string | null;
  skipExpr: string | null;
}

const TRANSITION_FOR_STATE: Partial<
  Record<RunNodeState['state'], NodeTransitionEvent['transition']>
> = {
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
};

/**
 * Groups a run's `node_transition` events under the engine's node states. The
 * state is the engine's, copied verbatim; the console keeps no fold of its own,
 * because a client fold drifts from the engine whenever a node event (a resume
 * reset, a suspension) is taught to one and not the other. A served node with no
 * transitions yet has no stream position and is not returned. Sorted by
 * `startedAt`.
 */
export function foldNodeRuns(events: RunEvent[], nodes: readonly RunNodeState[]): NodeRun[] {
  const byNode = new Map<string, NodeTransitionEvent[]>();
  for (const e of events) {
    if (e.kind !== 'node_transition' || e.nodeId === null) continue;
    const list = byNode.get(e.nodeId) ?? [];
    list.push(e);
    byNode.set(e.nodeId, list);
  }

  const runs: NodeRun[] = [];
  for (const node of nodes) {
    const transitions = byNode.get(node.node_id);
    if (transitions === undefined) continue;
    let completed: NodeTransitionEvent | null = null;
    let skipped: NodeTransitionEvent | null = null;
    let ended: NodeTransitionEvent | null = null;
    let nodeName = '';
    let startedAt = transitions[0]?.timestamp ?? '';
    const endingTransition = TRANSITION_FOR_STATE[node.state];
    for (const t of transitions) {
      if (new Date(t.timestamp).getTime() < new Date(startedAt).getTime()) startedAt = t.timestamp;
      if (nodeName === '' && t.nodeName !== '') nodeName = t.nodeName;
      if (t.transition === 'completed') completed = t;
      else if (t.transition === 'skipped') skipped = t;
      if (t.transition === endingTransition) ended = t;
    }
    runs.push({
      nodeId: node.node_id,
      nodeName: nodeName !== '' ? nodeName : node.node_id,
      status: node.state,
      startedAt,
      endedAt: ended?.timestamp ?? null,
      durationMs: ended?.durationMs ?? null,
      // Cost/turns/stop are only ever written on `node_completed`, so read them
      // from that transition (a failed/skipped terminal carries none).
      costUsd: completed?.costUsd ?? null,
      numTurns: completed?.numTurns ?? null,
      stopReason: completed?.stopReason ?? null,
      skipReason: skipped?.skipReason ?? null,
      skipExpr: skipped?.skipExpr ?? null,
    });
  }
  return runs.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
}

/**
 * Per-node terminal tally for a run's node-count readout (e.g. `7/8 nodes`), from
 * the engine's node states: `total` = nodes in a terminal state, `completed` =
 * nodes the engine reports completed.
 */
export function countTerminalNodes(nodes: readonly RunNodeState[]): {
  completed: number;
  total: number;
} {
  let completed = 0;
  let total = 0;
  for (const node of nodes) {
    if (node.state === 'running' || node.state === 'pending') continue;
    total += 1;
    if (node.state === 'completed') completed += 1;
  }
  return { completed, total };
}
