import { z } from '@hono/zod-openapi';
import { getRunArtifactsDirForRoot, resolveRunStorageRoot } from '@archon/paths/archon-paths';
import {
  RUN_GRAPH_METADATA_KEY,
  runGraphSchema,
  terminalRecordSchema,
  terminalStatusSchema,
  type TerminalRecord,
} from './schemas/terminal-record';
import { nodeSkipReasonSchema, skipCauseSchema, type WorkflowRun } from './schemas/workflow-run';
import { observeArtifactManifest } from './terminal-artifact-manifest';

export interface TerminalRecordEvent {
  event_type: string;
  step_name?: string | null;
  data: unknown;
}
const eventDataSchema = z.record(z.string(), z.unknown());
function eventData(value: unknown): Record<string, unknown> {
  return eventDataSchema.parse(typeof value === 'string' ? JSON.parse(value) : (value ?? {}));
}

/** Fold ordered durable events; never reconstruct producer values from artifact contents. */
export async function buildTerminalRecord(input: {
  run: Pick<WorkflowRun, 'id' | 'status' | 'outcome' | 'metadata' | 'output_root'>;
  events: readonly TerminalRecordEvent[];
}): Promise<TerminalRecord> {
  const { run, events } = input;
  const graph = runGraphSchema.safeParse(run.metadata?.[RUN_GRAPH_METADATA_KEY]);
  const nodes = new Map<string, TerminalRecord['nodes'][number]>();
  const outputs = new Map<string, Record<string, unknown>>();
  const failureOrder = new Map<string, number>();
  if (graph.success)
    for (const nodeId of graph.data.node_ids)
      nodes.set(nodeId, { node_id: nodeId, state: 'pending' });
  for (const [index, event] of events.entries()) {
    const nodeId = event.step_name;
    if (!nodeId) continue;
    switch (event.event_type) {
      case 'node_started':
      case 'node_always_run_reset':
      case 'node_prior_cache_invalidated':
        nodes.set(nodeId, {
          node_id: nodeId,
          state: event.event_type === 'node_started' ? 'running' : 'pending',
        });
        outputs.delete(nodeId);
        failureOrder.delete(nodeId);
        break;
      case 'node_completed':
      case 'node_skipped_prior_success':
        nodes.set(nodeId, { node_id: nodeId, state: 'completed' });
        outputs.set(nodeId, eventData(event.data));
        failureOrder.delete(nodeId);
        break;
      case 'node_failed': {
        const data = eventData(event.data);
        nodes.set(nodeId, {
          node_id: nodeId,
          state: 'failed',
          ...(typeof data.error === 'string' ? { error: data.error } : {}),
        });
        outputs.delete(nodeId);
        failureOrder.set(nodeId, index);
        break;
      }
      case 'node_skipped': {
        const data = eventData(event.data);
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
  let returns: TerminalRecord['returns'];
  const selected = graph.success ? graph.data.returns : undefined;
  if (selected === undefined) {
    returns = {
      availability: 'unavailable',
      node_id: null,
      reason: graph.success ? 'not_declared' : 'graph_unavailable',
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
