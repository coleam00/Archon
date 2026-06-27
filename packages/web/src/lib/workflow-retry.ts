import type { DagNodeState, WorkflowRunStatus } from '@/lib/types';

export type WorkflowRetryRunIneligibility = 'run-not-failed' | 'cli-created' | 'missing-web-parent';

export interface WorkflowRetryRunContext {
  runId: string;
  status: WorkflowRunStatus;
  parentPlatformId: string | null;
  conversationPlatformId: string | null;
}

export interface RetryableNodeState {
  nodeId: string;
  status: DagNodeState['status'];
  retryEpoch?: number;
  latestRetryEpoch?: number;
  routeDecision?: Record<string, unknown> | null;
}

export type WorkflowNodeRetryActionState =
  | { kind: 'hidden' }
  | { kind: 'web'; runId: string; nodeId: string }
  | { kind: 'cli'; command: string }
  | { kind: 'route-loop-guidance'; fromNodeId: string; command?: string };

export function buildRetryWorkflowNodePath(runId: string, nodeId: string): string {
  return `/api/workflows/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/retry`;
}

export function buildCliRetryCommand(runId: string, nodeId: string): string {
  return `archon workflow retry-node ${runId} ${nodeId}`;
}

export function isRetryableFailedNode(node: RetryableNodeState): boolean {
  if (node.status !== 'failed') return false;
  if (node.retryEpoch === undefined || node.latestRetryEpoch === undefined) return true;
  return node.retryEpoch === node.latestRetryEpoch;
}

export function getRouteLoopRetryFromNodeId(node: RetryableNodeState): string | null {
  const routeDecision = node.routeDecision;
  if (!routeDecision) return null;

  const fromNodeId = routeDecision.from;
  return typeof fromNodeId === 'string' && fromNodeId.length > 0 ? fromNodeId : null;
}

export function getWorkflowRetryRunIneligibility(
  run: WorkflowRetryRunContext
): WorkflowRetryRunIneligibility | null {
  if (run.status !== 'failed') return 'run-not-failed';
  if (!run.parentPlatformId) {
    return run.conversationPlatformId ? 'cli-created' : 'missing-web-parent';
  }
  return null;
}

export function getWorkflowNodeRetryActionState(
  run: WorkflowRetryRunContext,
  node: RetryableNodeState
): WorkflowNodeRetryActionState {
  const routeLoopFromNodeId = getRouteLoopRetryFromNodeId(node);
  if (run.status === 'failed' && routeLoopFromNodeId) {
    const ineligible = getWorkflowRetryRunIneligibility(run);
    return {
      kind: 'route-loop-guidance',
      fromNodeId: routeLoopFromNodeId,
      ...(ineligible === 'cli-created'
        ? { command: buildCliRetryCommand(run.runId, routeLoopFromNodeId) }
        : {}),
    };
  }

  if (!isRetryableFailedNode(node)) return { kind: 'hidden' };

  const ineligible = getWorkflowRetryRunIneligibility(run);
  if (ineligible === null) {
    return { kind: 'web', runId: run.runId, nodeId: node.nodeId };
  }
  if (ineligible === 'cli-created') {
    return { kind: 'cli', command: buildCliRetryCommand(run.runId, node.nodeId) };
  }
  return { kind: 'hidden' };
}

export function normalizeRetryWorkflowNodeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
