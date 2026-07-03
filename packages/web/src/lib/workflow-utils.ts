import type { DagNodeState, WorkflowRunStatus, WorkflowStepStatus } from '@/lib/types';

/**
 * Check if a workflow status represents a terminal (finished) state.
 */
export function isTerminalStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function terminalNodeStatus(status: WorkflowRunStatus): WorkflowStepStatus {
  return status === 'completed' ? 'completed' : 'failed';
}

function terminalNodeError(status: WorkflowRunStatus): string | undefined {
  if (status === 'cancelled') return 'Cancelled by user';
  if (status === 'failed') return 'Workflow stopped';
  return undefined;
}

/**
 * Workflow events are best-effort history. If a run is terminal but the last
 * node event is still `running`, render the node as stopped so the graph does
 * not contradict the run status.
 */
export function settleRunningDagNodesForTerminalStatus(
  status: WorkflowRunStatus,
  dagNodes: DagNodeState[]
): DagNodeState[] {
  if (!isTerminalStatus(status)) return dagNodes;

  const nextStatus = terminalNodeStatus(status);
  const fallbackError = terminalNodeError(status);
  let changed = false;
  const nextNodes = dagNodes.map(node => {
    if (node.status !== 'running') return node;
    changed = true;
    return {
      ...node,
      status: nextStatus,
      ...(fallbackError && !node.error ? { error: fallbackError } : {}),
    };
  });

  return changed ? nextNodes : dagNodes;
}
