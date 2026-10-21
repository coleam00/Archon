import { formatDuration } from '@archon/paths/duration';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { readNodeRecordData, readNodeRecordEvent } from '@archon/workflows/node-record-reader';
import type { NodeExecutionMetadata } from '@archon/workflows/schemas/node-execution';
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
  const startTimes = new Map<string, number>();
  const summaries = new Map<string, NodeSummary>();
  // Kept apart from `summaries`, which a retry's node_started resets: earlier attempts'
  // sessions stay listed.
  const sessionIds = new Map<string, string[]>();
  const recordSession = (nodeId: string, sessionId: unknown): void => {
    if (typeof sessionId !== 'string') return;
    const ids = sessionIds.get(nodeId) ?? [];
    if (!ids.includes(sessionId)) sessionIds.set(nodeId, [...ids, sessionId]);
  };

  for (const event of events) {
    const nodeId = event.step_name;
    if (!nodeId) continue;
    if (event.event_type === 'loop_iteration_completed') {
      recordSession(nodeId, readNodeRecordData(event.data).session_id);
      continue;
    }
    const record = readNodeRecordEvent(event);
    if (!record) continue;
    recordSession(nodeId, record.data.session_id);
    const execution = record.metadata;

    switch (record.eventType) {
      case 'node_started': {
        startTimes.set(nodeId, new Date(event.created_at).getTime());
        // A retry is a new active attempt, so stale terminal details must not
        // leak into the compact current-state summary.
        summaries.set(nodeId, {
          nodeId,
          state: 'running',
          startedAt: event.created_at,
          ...(execution === undefined ? {} : { execution }),
        });
        break;
      }
      case 'node_always_run_reset':
      case 'node_prior_cache_invalidated': {
        startTimes.delete(nodeId);
        summaries.set(nodeId, { nodeId, state: 'pending' });
        break;
      }
      case 'node_suspended': {
        summaries.set(nodeId, {
          nodeId,
          state: 'running',
          startedAt: summaries.get(nodeId)?.startedAt,
          ...(execution === undefined ? {} : { execution }),
        });
        break;
      }
      case 'node_completed': {
        const started = startTimes.get(nodeId);
        const endTime = new Date(event.created_at).getTime();
        summaries.set(nodeId, {
          nodeId,
          state: 'completed',
          startedAt: summaries.get(nodeId)?.startedAt,
          durationMs:
            execution?.timing.durationMs ?? (started !== undefined ? endTime - started : undefined),
          outputPreview: outputPreviewOf(record.data.node_output),
          ...(execution === undefined ? {} : { execution }),
        });
        break;
      }
      case 'node_failed': {
        const started = startTimes.get(nodeId);
        const endTime = new Date(event.created_at).getTime();
        summaries.set(nodeId, {
          nodeId,
          state: 'failed',
          startedAt: summaries.get(nodeId)?.startedAt,
          durationMs:
            execution?.timing.durationMs ?? (started !== undefined ? endTime - started : undefined),
          error: record.data.error ?? 'Unknown error',
          ...(record.data.blocked_on_child_run_id === undefined
            ? {}
            : { blockedOnChildRunId: record.data.blocked_on_child_run_id }),
          ...(execution === undefined ? {} : { execution }),
        });
        break;
      }
      case 'node_skipped': {
        const parsedCause = skipCauseSchema.safeParse(record.data.cause);
        summaries.set(nodeId, {
          nodeId,
          state: 'skipped',
          ...(parsedCause.success ? { cause: parsedCause.data } : {}),
          ...(execution === undefined ? {} : { execution }),
        });
        break;
      }
      case 'node_skipped_prior_success': {
        // The opposite of node_skipped: the node ran and succeeded on an earlier
        // pass, and this resume declined to re-run it. The engine re-emits one per
        // resume pass — including its own durable-wait continuation — so folding
        // these into `skipped` reported completed work as never run, and the last
        // write erased the original duration and output (#2973). The earlier
        // node_completed summary is the truth about the run, so never overwrite it.
        // A reset left nothing to keep: the prior attempt's details went with it.
        const existing = summaries.get(nodeId);
        if (existing !== undefined && existing.state !== 'pending') break;
        // The original node_completed is not in this log or was reset. The
        // replay still carries the prior output, so report the success it
        // describes; there is no start time to derive a duration from.
        summaries.set(nodeId, {
          nodeId,
          state: 'completed',
          outputPreview: outputPreviewOf(record.data.node_output),
        });
        break;
      }
    }
  }

  return [...summaries.values()].map(summary => {
    const ids = sessionIds.get(summary.nodeId);
    return ids === undefined ? summary : { ...summary, sessionIds: ids };
  });
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
    const iconMap: Record<NodeSummary['state'], string> = {
      completed: '✓',
      failed: '✗',
      skipped: '-',
      running: '◌',
      pending: '○',
    };
    const icon = iconMap[node.state];
    const duration = node.durationMs !== undefined ? ` (${formatDuration(node.durationMs)})` : '';
    const stateLabel =
      node.state === 'running' || node.state === 'pending' ? ` (${node.state})` : '';
    const skipCause = node.cause ? ` (${formatSkipCause(node.cause)})` : '';
    console.log(`    ${icon} ${node.nodeId}${duration}${stateLabel}${skipCause}`);
    if (node.outputPreview !== undefined) {
      console.log(`        Output: ${node.outputPreview}`);
    }
    if (node.error !== undefined) {
      console.log(`        Error:  ${node.error}`);
    }
    if (node.sessionIds !== undefined) {
      const label = node.sessionIds.length === 1 ? 'Session' : 'Sessions';
      console.log(`        ${label}: ${node.sessionIds.join(', ')}`);
    }
    if (node.blockedOnChildRunId !== undefined) {
      const abandon = spellWorkflowCommand(
        CLI_WORKFLOW_SURFACE,
        `abandon ${node.blockedOnChildRunId}`
      );
      console.log(`        Abandon: ${abandon}`);
    }
  }
}
