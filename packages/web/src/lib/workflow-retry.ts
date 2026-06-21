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
}

export type WorkflowNodeRetryActionState =
  | { kind: 'hidden' }
  | { kind: 'web'; runId: string; nodeId: string }
  | { kind: 'cli'; command: string };

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
