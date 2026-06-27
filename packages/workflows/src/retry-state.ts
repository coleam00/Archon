import type { DagNode, NodeOutput } from './schemas';
import { isRouteLoopNode } from './schemas';

export const RETRY_EVENT_TYPES = [
  'node_retry_requested',
  'node_retry_reset',
  'node_retry_failed',
] as const;

export type RetryEventType = (typeof RETRY_EVENT_TYPES)[number];

export interface RetryProjectionEvent {
  event_type: string;
  step_name?: string | null;
  data?: Record<string, unknown> | string | null;
}

export interface RetryNodeProjection {
  node_id: string;
  state: NodeOutput['state'];
  retry_epoch: number;
  output: string;
  error?: string;
  reason?: string;
}

function parseEventData(data: RetryProjectionEvent['data']): Record<string, unknown> {
  if (!data) return {};
  if (typeof data !== 'string') return data;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function getRetryEpoch(data: Record<string, unknown> | undefined): number {
  const value = data?.retry_epoch;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function isRetryEventType(eventType: string): eventType is RetryEventType {
  return (RETRY_EVENT_TYPES as readonly string[]).includes(eventType);
}

export function getDagDescendantNodeIds(nodes: readonly DagNode[], targetNodeId: string): string[] {
  const childrenByNode = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      const children = childrenByNode.get(dep) ?? [];
      children.push(node.id);
      childrenByNode.set(dep, children);
    }
  }

  const descendants = new Set<string>();
  const stack = [...(childrenByNode.get(targetNodeId) ?? [])];
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId || descendants.has(nodeId)) continue;
    descendants.add(nodeId);
    stack.push(...(childrenByNode.get(nodeId) ?? []));
  }

  return nodes.filter(node => descendants.has(node.id)).map(node => node.id);
}

export function getRetryInvalidatedNodeIds(
  nodes: readonly DagNode[],
  targetNodeId: string
): string[] {
  const targetNode = nodes.find(node => node.id === targetNodeId);
  if (!targetNode) {
    throw new Error(`Retry target node not found in current workflow DAG: ${targetNodeId}`);
  }
  if (isRouteLoopNode(targetNode)) {
    throw new Error(
      `Cannot retry route_loop controller node '${targetNodeId}' directly; retry its source node '${targetNode.route_loop.from}' instead`
    );
  }
  return [targetNodeId, ...getDagDescendantNodeIds(nodes, targetNodeId)];
}

export function projectLatestEffectiveNodeStates(
  events: readonly RetryProjectionEvent[]
): Map<string, RetryNodeProjection> {
  const states = new Map<string, RetryNodeProjection>();

  for (const event of events) {
    const data = parseEventData(event.data);
    const retryEpoch = getRetryEpoch(data);

    if (event.event_type === 'node_retry_requested') {
      const invalidated = data.invalidated_node_ids;
      if (Array.isArray(invalidated)) {
        for (const rawNodeId of invalidated) {
          if (typeof rawNodeId !== 'string') continue;
          states.set(rawNodeId, {
            node_id: rawNodeId,
            state: 'pending',
            retry_epoch: retryEpoch,
            output: '',
          });
        }
      }
      continue;
    }

    const nodeId =
      typeof data.node_id === 'string'
        ? data.node_id
        : typeof event.step_name === 'string'
          ? event.step_name
          : undefined;
    if (!nodeId) continue;

    if (event.event_type === 'node_started') {
      states.set(nodeId, {
        node_id: nodeId,
        state: 'running',
        retry_epoch: retryEpoch,
        output: '',
      });
      continue;
    }

    if (
      event.event_type === 'node_completed' ||
      event.event_type === 'node_skipped_prior_success'
    ) {
      states.set(nodeId, {
        node_id: nodeId,
        state: 'completed',
        retry_epoch: retryEpoch,
        output: typeof data.node_output === 'string' ? data.node_output : '',
      });
      continue;
    }

    if (event.event_type === 'node_failed') {
      states.set(nodeId, {
        node_id: nodeId,
        state: 'failed',
        retry_epoch: retryEpoch,
        output: '',
        error: typeof data.error === 'string' ? data.error : 'Node failed',
      });
      continue;
    }

    if (event.event_type === 'node_skipped') {
      states.set(nodeId, {
        node_id: nodeId,
        state: 'skipped',
        retry_epoch: retryEpoch,
        output: '',
        reason: typeof data.reason === 'string' ? data.reason : undefined,
      });
    }
  }

  return states;
}

export function getLatestEffectiveNodeState(
  events: readonly RetryProjectionEvent[],
  nodeId: string
): RetryNodeProjection | null {
  return projectLatestEffectiveNodeStates(events).get(nodeId) ?? null;
}
