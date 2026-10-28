import { formatDuration } from '@archon/paths/duration';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  readNodeRecordData,
  readNodeRecordEvent,
  type ReadNodeRecordEvent,
} from '@archon/workflows/node-record-reader';
import type { NodeExecutionMetadata } from '@archon/workflows/schemas/node-execution';
import {
  describeUnfinishedFanOut,
  fanOutSlotOutcomeLabel,
  type FanOutOutcome,
} from '@archon/workflows/schemas/fan-out-outcome';
import type { NodeState } from '@archon/workflows/schemas/node-state';
import {
  NODE_STATE_EVENT_TYPES,
  PROVIDER_EVENT_ROW_TYPES,
  type WorkflowEventType,
} from '@archon/workflows/store';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import { skipCauseSchema, runAttention } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun, RunAttention, SkipCause } from '@archon/workflows/schemas/workflow-run';
import { RUN_GRAPH_METADATA_KEY, runGraphSchema } from '@archon/workflows/schemas/terminal-record';
import { spellWorkflowCommand } from '@archon/workflows/deps';
import { CLI_WORKFLOW_SURFACE } from '../utils/workflow-surface';
import { getLog } from './workflow-shared';

export interface NodeSummary {
  nodeId: string;
  state: NodeState;
  startedAt?: string;
  durationMs?: number;
  outputPreview?: string;
  error?: string;
  /** Set when the failure is "a live child run blocks this node"; abandoning it unblocks. */
  blockedOnChildRunId?: string;
  cause?: SkipCause;
  execution?: NodeExecutionMetadata;
  /** Every provider session id the node's attempts and loop iterations recorded, in order. */
  sessionIds?: string[];
  /** A `workflow:` fan-out node's per-slot record. */
  fanOutOutcome?: FanOutOutcome;
}

function fanOutFields(outcome: FanOutOutcome | undefined): Pick<NodeSummary, 'fanOutOutcome'> {
  return outcome === undefined ? {} : { fanOutOutcome: outcome };
}

/** Non-completed slots shown under a fan-out node; the tally still counts every slot. */
const FAN_OUT_SLOT_DISPLAY_LIMIT = 10;

/**
 * Lines describing a fan-out node's unfinished child work, or none when every slot
 * completed. The "more" count comes from the stored tally, never from the shown list.
 */
export function formatFanOutOutcome(outcome: FanOutOutcome | undefined): string[] {
  if (outcome === undefined) return [];
  const { tally } = outcome;
  const unfinished = tally.total - tally.completed;
  if (unfinished === 0) return [];
  const shown = outcome.slots
    .filter(slot => slot.outcome !== 'completed')
    .slice(0, FAN_OUT_SLOT_DISPLAY_LIMIT)
    .map(slot => {
      const reason =
        'cancel_reason' in slot && slot.cancel_reason ? ` (${slot.cancel_reason})` : '';
      const parts = [
        `item ${String(slot.index)}: ${fanOutSlotOutcomeLabel(slot.outcome)}${reason}`,
        ...('child_run_id' in slot ? [`run ${slot.child_run_id}`] : []),
        ...('error' in slot && slot.error !== undefined ? [slot.error] : []),
      ];
      return `  ${parts.join(' — ')}`;
    });
  const more = unfinished - shown.length;
  return [
    `Fan-out work: ${describeUnfinishedFanOut(tally)}`,
    ...shown,
    ...(more > 0 ? [`  … and ${String(more)} more (see --json)`] : []),
  ];
}

export function formatSkipCause(cause: SkipCause): string {
  switch (cause.kind) {
    case 'condition':
      return `condition: ${cause.expr}`;
    case 'condition_parse_error':
      return `condition parse error: ${cause.expr}`;
    case 'timeout':
      return 'timeout';
    case 'upstream_failed':
      return `upstream failed: ${cause.origin}`;
    case 'upstream_skipped':
      return `upstream skipped: ${cause.origin}`;
  }
}

/**
 * Bounded preview of a node's persisted output, shared by the two events that
 * report a success so both render the same cap.
 */
function outputPreviewOf(rawOutput: unknown): string | undefined {
  if (typeof rawOutput !== 'string') return undefined;
  return rawOutput.slice(0, 200) + (rawOutput.length > 200 ? '...' : '');
}

/**
 * The event types `buildNodeSummaries` reads: every node-state record
 * `readNodeRecordEvent` accepts, plus loop iterations for their session ids. A caller
 * that fetches only these gets the same summaries as one that fetches the whole log.
 */
export const NODE_SUMMARY_EVENT_TYPES = [
  ...NODE_STATE_EVENT_TYPES,
  'loop_iteration_completed',
] as const satisfies readonly WorkflowEventType[];

/**
 * Derive per-node summaries from a run's workflow events.
 * Processes node_started / node_completed / node_failed / node_skipped /
 * node_skipped_prior_success events — the last two mean opposite things and are
 * handled separately — loop iterations' session ids, and the resume resets
 * (node_always_run_reset, node_prior_cache_invalidated) that send a node back
 * to pending, as the run's terminal record does.
 */
export function buildNodeSummaries(events: WorkflowEventRow[]): NodeSummary[] {
  const fold: NodeSummaryFold = {
    startTimes: new Map(),
    summaries: new Map(),
    sessionIds: new Map(),
  };
  for (const event of events) foldNodeEvent(fold, event);
  return [...fold.summaries.values()].map(summary => {
    const ids = fold.sessionIds.get(summary.nodeId);
    return ids === undefined ? summary : { ...summary, sessionIds: ids };
  });
}

interface NodeSummaryFold {
  startTimes: Map<string, number>;
  summaries: Map<string, NodeSummary>;
  /**
   * Kept apart from `summaries`, which a retry's node_started resets: earlier attempts'
   * sessions stay listed.
   */
  sessionIds: Map<string, string[]>;
}

function foldNodeEvent(fold: NodeSummaryFold, event: WorkflowEventRow): void {
  const nodeId = event.step_name;
  if (!nodeId) return;
  if (event.event_type === 'loop_iteration_completed') {
    recordSession(fold, nodeId, readNodeRecordData(event.data).session_id);
    return;
  }
  const record = readNodeRecordEvent(event);
  if (!record) return;
  recordSession(fold, nodeId, record.data.session_id);
  if (record.eventType === 'node_started') {
    fold.startTimes.set(nodeId, new Date(event.created_at).getTime());
  } else if (isResumeReset(record)) {
    fold.startTimes.delete(nodeId);
  }
  const next = nextNodeSummary(
    nodeId,
    record,
    event.created_at,
    fold.summaries.get(nodeId),
    fold.startTimes.get(nodeId)
  );
  if (next !== undefined) fold.summaries.set(nodeId, next);
}

function recordSession(fold: NodeSummaryFold, nodeId: string, sessionId: unknown): void {
  if (typeof sessionId !== 'string') return;
  const ids = fold.sessionIds.get(nodeId) ?? [];
  if (!ids.includes(sessionId)) fold.sessionIds.set(nodeId, [...ids, sessionId]);
}

function isResumeReset(record: ReadNodeRecordEvent): boolean {
  return (
    record.eventType === 'node_always_run_reset' ||
    record.eventType === 'node_prior_cache_invalidated'
  );
}

/** The node's summary after this record, or undefined to keep the current one. */
function nextNodeSummary(
  nodeId: string,
  record: ReadNodeRecordEvent,
  createdAt: string,
  existing: NodeSummary | undefined,
  startTime: number | undefined
): NodeSummary | undefined {
  const execution = record.metadata;
  switch (record.eventType) {
    case 'node_started':
      // A retry is a new active attempt, so stale terminal details must not
      // leak into the compact current-state summary.
      return { nodeId, state: 'running', startedAt: createdAt, ...executionFields(execution) };
    case 'node_always_run_reset':
    case 'node_prior_cache_invalidated':
      return { nodeId, state: 'pending' };
    case 'node_suspended':
      return {
        nodeId,
        state: 'running',
        startedAt: existing?.startedAt,
        ...executionFields(execution),
      };
    case 'node_completed':
      return {
        nodeId,
        state: 'completed',
        startedAt: existing?.startedAt,
        durationMs: nodeDurationMs(record, createdAt, startTime),
        outputPreview: outputPreviewOf(record.data.node_output),
        ...fanOutFields(record.data.fan_out_outcome),
        ...executionFields(execution),
      };
    case 'node_failed':
      return failedNodeSummary(nodeId, record, createdAt, existing, startTime);
    case 'node_skipped': {
      const parsedCause = skipCauseSchema.safeParse(record.data.cause);
      return {
        nodeId,
        state: 'skipped',
        ...(parsedCause.success ? { cause: parsedCause.data } : {}),
        ...executionFields(execution),
      };
    }
    case 'node_skipped_prior_success':
      return priorSuccessSummary(nodeId, record, existing);
  }
}

function failedNodeSummary(
  nodeId: string,
  record: ReadNodeRecordEvent,
  createdAt: string,
  existing: NodeSummary | undefined,
  startTime: number | undefined
): NodeSummary {
  const { data } = record;
  return {
    nodeId,
    state: 'failed',
    startedAt: existing?.startedAt,
    durationMs: nodeDurationMs(record, createdAt, startTime),
    error: data.error ?? 'Unknown error',
    ...(data.blocked_on_child_run_id === undefined
      ? {}
      : { blockedOnChildRunId: data.blocked_on_child_run_id }),
    ...fanOutFields(data.fan_out_outcome),
    ...executionFields(record.metadata),
  };
}

/**
 * The opposite of node_skipped: the node ran and succeeded on an earlier pass, and this
 * resume declined to re-run it. The engine re-emits one per resume pass — including its
 * own durable-wait continuation — so folding these into `skipped` reported completed
 * work as never run, and the last write erased the original duration and output (#2973).
 * The earlier node_completed summary is the truth about the run, so never overwrite it.
 * A reset left nothing to keep: the prior attempt's details went with it.
 */
function priorSuccessSummary(
  nodeId: string,
  record: ReadNodeRecordEvent,
  existing: NodeSummary | undefined
): NodeSummary | undefined {
  if (existing !== undefined && existing.state !== 'pending') return undefined;
  // The original node_completed is not in this log or was reset. The
  // replay still carries the prior output, so report the success it
  // describes; there is no start time to derive a duration from.
  return { nodeId, state: 'completed', outputPreview: outputPreviewOf(record.data.node_output) };
}

function nodeDurationMs(
  record: ReadNodeRecordEvent,
  createdAt: string,
  startTime: number | undefined
): number | undefined {
  const derived = startTime !== undefined ? new Date(createdAt).getTime() - startTime : undefined;
  return record.metadata?.timing.durationMs ?? derived;
}

function executionFields(
  execution: NodeExecutionMetadata | undefined
): Pick<NodeSummary, 'execution'> {
  return execution === undefined ? {} : { execution };
}

/**
 * A run's event rows. Provider events (every agent text block, tool call and output)
 * are left out unless the caller prints raw rows: node summaries and terminal records
 * never read them, and a long run has thousands.
 */
export function listRunEvents(
  host: WorkflowHost,
  runId: string,
  rawEvents: boolean
): Promise<WorkflowEventRow[]> {
  return rawEvents
    ? host.deps.store.listWorkflowEvents(runId)
    : host.deps.store.listWorkflowEvents(runId, {
        excludeEventTypes: PROVIDER_EVENT_ROW_TYPES,
      });
}

/**
 * Per-node state for `workflow runs --json --verbose`: every node the run declared in
 * its `terminal_graph`, in declared order and `pending` until an event reaches it,
 * folded with `buildNodeSummaries`. A node that ran but is not declared (a loop body
 * such as `candidates.step`) follows the declared ones in first-event order — the same
 * ordering `buildTerminalRecord` gives finished runs. A run without a recorded graph
 * reports only the nodes its events reached.
 */
export function buildRunNodes(
  run: Pick<WorkflowRun, 'metadata'>,
  events: WorkflowEventRow[]
): NodeSummary[] {
  const nodes = new Map<string, NodeSummary>();
  const graph = runGraphSchema.safeParse(run.metadata[RUN_GRAPH_METADATA_KEY]);
  if (graph.success)
    for (const nodeId of graph.data.node_ids) nodes.set(nodeId, { nodeId, state: 'pending' });
  for (const summary of buildNodeSummaries(events)) nodes.set(summary.nodeId, summary);
  return [...nodes.values()];
}

/**
 * `workflow runs --json --verbose` adds `nodes` and `attention` to each run. Node
 * events for every listed run come from one query, filtered to the types
 * `buildNodeSummaries` reads.
 */
export async function withRunDetail<
  Run extends Pick<WorkflowRun, 'id' | 'status' | 'metadata' | 'completed_at'>,
>(
  host: WorkflowHost,
  runs: Run[]
): Promise<(Run & { nodes: NodeSummary[]; attention: RunAttention | null })[]> {
  const eventsByRun = await host.deps.store.listEventsForRuns(
    runs.map(run => run.id),
    NODE_SUMMARY_EVENT_TYPES
  );
  return runs.map(run => ({
    ...run,
    nodes: buildRunNodes(run, eventsByRun.get(run.id) ?? []),
    attention: runAttention(run),
  }));
}

/**
 * Keep query failure distinct from an empty history: human output can retain the
 * run summary with a warning, while JSON callers must fail the request.
 */
export async function fetchVerboseEvents(
  host: WorkflowHost,
  runId: string,
  rawEvents: boolean
): Promise<{ events: WorkflowEventRow[]; failed: boolean }> {
  try {
    return { events: await listRunEvents(host, runId, rawEvents), failed: false };
  } catch (error) {
    getLog().warn({ err: error as Error, runId }, 'cli.workflow_events_fetch_failed');
    return { events: [], failed: true };
  }
}

/**
 * Render per-node summaries for a run's events as an indented "Nodes:" block.
 * Shared by `workflow status --verbose` and `workflow get --verbose`.
 * Prints nothing when the run has no node events.
 */
export function printVerboseNodes(events: WorkflowEventRow[]): void {
  const nodes = buildNodeSummaries(events);
  if (nodes.length === 0) return;
  console.log('  Nodes:');
  for (const node of nodes) {
    console.log(formatNodeHeading(node));
    for (const line of formatNodeDetails(node)) console.log(`        ${line}`);
  }
}

function formatNodeHeading(node: NodeSummary): string {
  const iconMap: Record<NodeSummary['state'], string> = {
    completed: '✓',
    failed: '✗',
    skipped: '-',
    running: '◌',
    pending: '○',
  };
  const icon = iconMap[node.state];
  const duration = node.durationMs !== undefined ? ` (${formatDuration(node.durationMs)})` : '';
  const stateLabel = node.state === 'running' || node.state === 'pending' ? ` (${node.state})` : '';
  const skipCause = node.cause ? ` (${formatSkipCause(node.cause)})` : '';
  return `    ${icon} ${node.nodeId}${duration}${stateLabel}${skipCause}`;
}

function formatNodeDetails(node: NodeSummary): string[] {
  const lines: string[] = [];

  if (node.outputPreview !== undefined) {
    lines.push(`Output: ${node.outputPreview}`);
  }
  if (node.error !== undefined) {
    lines.push(`Error:  ${node.error}`);
  }
  lines.push(...formatFanOutOutcome(node.fanOutOutcome));
  if (node.sessionIds !== undefined) {
    const label = node.sessionIds.length === 1 ? 'Session' : 'Sessions';
    lines.push(`${label}: ${node.sessionIds.join(', ')}`);
  }
  if (node.blockedOnChildRunId !== undefined) {
    const abandon = spellWorkflowCommand(
      CLI_WORKFLOW_SURFACE,
      `abandon ${node.blockedOnChildRunId}`
    );
    lines.push(`Abandon: ${abandon}`);
  }
  return lines;
}
