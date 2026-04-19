import type { WorkflowEventResponse } from './api';
import { ensureUtc } from './format';
import type { DagNodeState, LoopIterationInfo, WorkflowRunStatus } from './types';

function getEventNodeId(event: WorkflowEventResponse): string {
  const dataNodeId = event.data.nodeId;
  return event.step_name ?? (typeof dataNodeId === 'string' ? dataNodeId : '');
}

function getEventTime(event: WorkflowEventResponse): number {
  return new Date(ensureUtc(event.created_at)).getTime();
}

function getLoopIterationStatus(event: WorkflowEventResponse): LoopIterationInfo['status'] {
  if (event.event_type === 'loop_iteration_started') return 'running';
  if (event.event_type === 'loop_iteration_completed') return 'completed';
  return 'failed';
}

export function deriveDagNodesFromEvents(events: WorkflowEventResponse[]): DagNodeState[] {
  const sortedEvents = [...events].sort((a, b) => getEventTime(a) - getEventTime(b));
  const nodeMap = new Map<string, DagNodeState>();

  for (const event of sortedEvents) {
    if (!event.event_type.startsWith('node_')) continue;

    const nodeId = getEventNodeId(event);
    if (!nodeId) continue;

    const status =
      event.event_type === 'node_started'
        ? 'running'
        : event.event_type === 'node_completed'
          ? 'completed'
          : event.event_type === 'node_failed'
            ? 'failed'
            : 'skipped';

    const existing = nodeMap.get(nodeId);
    if (!existing || status !== 'running') {
      nodeMap.set(nodeId, {
        ...(existing ?? {}),
        nodeId,
        name: existing?.name ?? nodeId,
        status,
        duration: event.data.duration_ms as number | undefined,
        error: event.data.error as string | undefined,
        reason: event.data.reason as 'when_condition' | 'trigger_rule' | undefined,
      });
    }
  }

  for (const event of sortedEvents) {
    if (!event.event_type.startsWith('loop_iteration_')) continue;

    const nodeId = getEventNodeId(event);
    if (!nodeId) continue;

    const iteration = event.data.iteration as number | undefined;
    const maxIterations = event.data.maxIterations as number | undefined;
    if (iteration === undefined) continue;

    const existing = nodeMap.get(nodeId);
    const iterationStatus = getLoopIterationStatus(event);
    const iterations = [...(existing?.iterations ?? [])];
    const existingIterationIndex = iterations.findIndex(item => item.iteration === iteration);
    const nextIteration: LoopIterationInfo = {
      iteration,
      status: iterationStatus,
      duration: event.data.duration as number | undefined,
    };

    if (existingIterationIndex >= 0) {
      iterations[existingIterationIndex] = nextIteration;
    } else {
      iterations.push(nextIteration);
    }

    const existingStatus = existing?.status;
    const status =
      iterationStatus === 'failed'
        ? 'failed'
        : existingStatus === 'completed' ||
            existingStatus === 'skipped' ||
            existingStatus === 'failed'
          ? existingStatus
          : 'running';

    nodeMap.set(nodeId, {
      ...(existing ?? {}),
      nodeId,
      name: existing?.name ?? nodeId,
      status,
      currentIteration: iteration,
      maxIterations: maxIterations ?? existing?.maxIterations,
      iterations,
    });
  }

  return Array.from(nodeMap.values());
}

export function deriveCurrentlyExecutingNode(
  events: WorkflowEventResponse[],
  workflowStatus: WorkflowRunStatus
): { nodeName: string; startedAt: number } | null {
  if (workflowStatus !== 'running') return null;

  const sortedEvents = [...events].sort((a, b) => getEventTime(a) - getEventTime(b));
  const startedNodes = new Map<string, number>();
  const completedNodes = new Set<string>();

  for (const event of sortedEvents) {
    const nodeId = getEventNodeId(event);
    if (!nodeId) continue;

    if (event.event_type === 'node_started') {
      startedNodes.set(nodeId, getEventTime(event));
      continue;
    }

    if (
      event.event_type === 'node_completed' ||
      event.event_type === 'node_failed' ||
      event.event_type === 'node_skipped'
    ) {
      completedNodes.add(nodeId);
    }
  }

  for (const [nodeId, startedAt] of startedNodes) {
    if (!completedNodes.has(nodeId)) {
      return { nodeName: nodeId, startedAt };
    }
  }

  const activeLoopIterations = new Map<string, { nodeName: string; startedAt: number }>();

  for (const event of sortedEvents) {
    if (!event.event_type.startsWith('loop_iteration_')) continue;

    const nodeId = getEventNodeId(event);
    const iteration = event.data.iteration as number | undefined;
    if (!nodeId || iteration === undefined) continue;

    const key = `${nodeId}:${String(iteration)}`;
    if (event.event_type === 'loop_iteration_started') {
      activeLoopIterations.set(key, { nodeName: nodeId, startedAt: getEventTime(event) });
    } else {
      activeLoopIterations.delete(key);
    }
  }

  return activeLoopIterations.values().next().value ?? null;
}

export function deriveNodeStartTimes(events: WorkflowEventResponse[]): Map<string, number> {
  const sortedEvents = [...events].sort((a, b) => getEventTime(a) - getEventTime(b));
  const nodeStartTimes = new Map<string, number>();

  for (const event of sortedEvents) {
    const nodeId = getEventNodeId(event);
    if (!nodeId || nodeStartTimes.has(nodeId)) continue;
    if (event.event_type !== 'node_started' && event.event_type !== 'loop_iteration_started')
      continue;
    nodeStartTimes.set(nodeId, getEventTime(event));
  }

  return nodeStartTimes;
}
