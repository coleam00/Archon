import { z } from 'zod';
import { getRunArtifactsDirForRoot, resolveRunStorageRoot } from '@archon/paths/archon-paths';
import {
  RUN_GRAPH_METADATA_KEY,
  runGraphSchema,
  terminalRecordSchema,
  terminalStatusSchema,
  type RunGraph,
  type RunNodeState,
  type TerminalRecord,
  WORKTREE_DISPOSITION_METADATA_KEY,
  worktreeDispositionSchema,
  type WorktreeDisposition,
} from './schemas/terminal-record';
import {
  nodeSkipReasonSchema,
  readOwnedWorktree,
  skipCauseSchema,
  type WorkflowRun,
} from './schemas/workflow-run';
import { observeArtifactManifest } from './terminal-artifact-manifest';
import {
  readNodeRecordData,
  readNodeRecordEvent,
  type ReadNodeRecordEvent,
} from './node-record-reader';
import { nodeFailureKindSchema, type NodeFailureKind } from './schemas/node-execution';
import type { FanOutOutcome } from './schemas/fan-out-outcome';

export interface TerminalRecordEvent {
  event_type: string;
  step_name?: string | null;
  data: unknown;
}
const eventDataSchema = z.record(z.string(), z.unknown());
function eventData(value: unknown): Record<string, unknown> {
  return eventDataSchema.parse(typeof value === 'string' ? JSON.parse(value) : (value ?? {}));
}

function withFanOutOutcome(
  state: RunNodeState,
  fanOutOutcome: FanOutOutcome | undefined
): RunNodeState {
  return fanOutOutcome === undefined ? state : { ...state, fan_out_outcome: fanOutOutcome };
}

interface NodeEventFold {
  graph: RunGraph | undefined;
  nodes: Map<string, RunNodeState>;
  outputs: Map<string, Record<string, unknown>>;
  failureOrder: Map<string, number>;
}

function foldNodeEvents(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): NodeEventFold {
  const parsed = runGraphSchema.safeParse(run.metadata?.[RUN_GRAPH_METADATA_KEY]);
  const graph = parsed.success ? parsed.data : undefined;
  const nodes = new Map<string, RunNodeState>();
  const outputs = new Map<string, Record<string, unknown>>();
  const failureOrder = new Map<string, number>();
  const folded = { graph, nodes, outputs, failureOrder };
  if (graph)
    for (const nodeId of graph.node_ids) nodes.set(nodeId, { node_id: nodeId, state: 'pending' });
  for (const [index, event] of events.entries()) {
    const nodeId = event.step_name;
    if (!nodeId) continue;
    const record = readNodeRecordEvent({
      workflow_run_id: run.id,
      step_name: nodeId,
      event_type: event.event_type,
      data: event.data,
    });
    if (!record) continue;
    foldNodeRecord(folded, record, nodeId, index);
  }
  return folded;
}

function foldNodeRecord(
  { nodes, outputs, failureOrder }: Omit<NodeEventFold, 'graph'>,
  record: ReadNodeRecordEvent,
  nodeId: string,
  index: number
): void {
  switch (record.eventType) {
    case 'node_started':
    case 'node_suspended':
    case 'node_always_run_reset':
    case 'node_prior_cache_invalidated':
      nodes.set(nodeId, {
        node_id: nodeId,
        state:
          record.eventType === 'node_started' || record.eventType === 'node_suspended'
            ? 'running'
            : 'pending',
      });
      outputs.delete(nodeId);
      failureOrder.delete(nodeId);
      break;
    case 'node_completed':
      nodes.set(
        nodeId,
        withFanOutOutcome({ node_id: nodeId, state: 'completed' }, record.data.fan_out_outcome)
      );
      outputs.set(nodeId, record.data);
      failureOrder.delete(nodeId);
      break;
    case 'node_skipped_prior_success':
      // A replayed node keeps the slot record its earlier completion wrote.
      nodes.set(
        nodeId,
        withFanOutOutcome(
          { node_id: nodeId, state: 'completed' },
          nodes.get(nodeId)?.fan_out_outcome
        )
      );
      outputs.set(nodeId, record.data);
      failureOrder.delete(nodeId);
      break;
    case 'node_failed': {
      const data = record.data;
      nodes.set(
        nodeId,
        withFanOutOutcome(
          {
            node_id: nodeId,
            state: 'failed',
            ...(typeof data.error === 'string' ? { error: data.error } : {}),
          },
          data.fan_out_outcome
        )
      );
      outputs.delete(nodeId);
      failureOrder.set(nodeId, index);
      break;
    }
    case 'node_skipped': {
      const data = record.data;
      const reason = nodeSkipReasonSchema.safeParse(data.reason);
      const cause = skipCauseSchema.safeParse(data.cause);
      nodes.set(nodeId, {
        node_id: nodeId,
        state: 'skipped',
        ...(reason.success ? { reason: reason.data } : {}),
        ...(cause.success ? { cause: cause.data } : {}),
      });
      outputs.delete(nodeId);
      failureOrder.delete(nodeId);
      break;
    }
  }
}

/** The engine's per-node state at any point in a run: the same fold the terminal record uses. */
export function buildRunNodeStates(
  run: Pick<WorkflowRun, 'id' | 'metadata'>,
  events: readonly TerminalRecordEvent[]
): RunNodeState[] {
  return [...foldNodeEvents(run, events).nodes.values()];
}

/**
 * Failed and cancelled runs keep their worktree without inspecting it; only a completed
 * run's disposition needs git, so the executor assesses it and stores it in run metadata
 * before the terminal write.
 */
function readWorktreeDisposition(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): WorktreeDisposition | undefined {
  if (!readOwnedWorktree(run.metadata)) return undefined;
  switch (run.status) {
    case 'failed':
      return { disposition: 'retained', reason: 'resumable' };
    case 'cancelled':
      return { disposition: 'retained', reason: 'cancelled' };
    case 'completed': {
      const parsed = worktreeDispositionSchema.safeParse(
        run.metadata?.[WORKTREE_DISPOSITION_METADATA_KEY]
      );
      return parsed.success ? parsed.data : undefined;
    }
    default:
      return undefined;
  }
}

/** Fold ordered durable events; never reconstruct producer values from artifact contents. */
export async function buildTerminalRecord(input: {
  run: Pick<WorkflowRun, 'id' | 'status' | 'outcome' | 'metadata' | 'output_root'>;
  events: readonly TerminalRecordEvent[];
}): Promise<TerminalRecord> {
  const { run, events } = input;
  const { graph, nodes, outputs, failureOrder } = foldNodeEvents(run, events);
  let returns: TerminalRecord['returns'];
  const selected = graph?.returns;
  if (selected === undefined) {
    returns = {
      availability: 'unavailable',
      node_id: null,
      reason: graph ? 'not_declared' : 'graph_unavailable',
    };
  } else {
    const data = outputs.get(selected);
    if (nodes.get(selected)?.state !== 'completed') {
      returns = { availability: 'unavailable', node_id: selected, reason: 'node_not_completed' };
    } else if (data && Object.hasOwn(data, 'structured_output')) {
      returns = { availability: 'available', node_id: selected, value: data.structured_output };
    } else if (data?.node_output_truncated === true) {
      returns = {
        availability: 'truncated',
        node_id: selected,
        spill_path:
          typeof data.node_output_spill_path === 'string' ? data.node_output_spill_path : null,
        original_bytes:
          typeof data.node_output_original_bytes === 'number'
            ? data.node_output_original_bytes
            : null,
      };
    } else if (typeof data?.node_output === 'string') {
      returns = { availability: 'available', node_id: selected, value: data.node_output };
    } else {
      returns = { availability: 'unavailable', node_id: selected, reason: 'output_not_persisted' };
    }
  }
  const root = resolveRunStorageRoot(run, null);
  const worktreeDisposition = readWorktreeDisposition(run);
  return terminalRecordSchema.parse({
    run_id: run.id,
    status: terminalStatusSchema.parse(run.status),
    outcome: run.outcome,
    error: typeof run.metadata?.error === 'string' ? run.metadata.error : null,
    first_failed_node: [...failureOrder].sort((left, right) => left[1] - right[1])[0]?.[0] ?? null,
    nodes: [...nodes.values()],
    returns,
    artifacts: await observeArtifactManifest(
      root === null ? null : getRunArtifactsDirForRoot(root, run.id),
      root ?? undefined,
      run.id
    ),
    ...(worktreeDisposition ? { worktree_disposition: worktreeDisposition } : {}),
  });
}

/** Historical terminal events have no record. Active resumed runs expose none. */
export function getTerminalRecord(
  runStatus: WorkflowRun['status'],
  events: readonly TerminalRecordEvent[]
): TerminalRecord | null {
  if (!terminalStatusSchema.safeParse(runStatus).success) return null;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.event_type !== `workflow_${runStatus}`) continue;
    const data = eventData(event.data);
    if (data.terminal_record === undefined) return null;
    const record = terminalRecordSchema.parse(data.terminal_record);
    if (record.status !== runStatus)
      throw new Error('Terminal record status differs from its terminal event');
    return record;
  }
  return null;
}

/**
 * The `node_failed` event behind a record's `first_failed_node`: the last one for that
 * node in `events`. Terminal telemetry and the attention stream both read the failure
 * cause through this, so they agree on which event is the failure.
 */
export function firstFailedNodeEvent<E extends TerminalRecordEvent>(
  record: Pick<TerminalRecord, 'first_failed_node'> | null,
  events: readonly E[]
): E | undefined {
  const node = record?.first_failed_node;
  if (node == null) return undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.event_type === 'node_failed' && event.step_name === node) return event;
  }
  return undefined;
}

/** The failure kind a `node_failed` event recorded; undefined when it recorded none. */
export function recordedFailureKind(event: TerminalRecordEvent): NodeFailureKind | undefined {
  const kind = nodeFailureKindSchema.safeParse(readNodeRecordData(event.data).failure_kind);
  return kind.success ? kind.data : undefined;
}
