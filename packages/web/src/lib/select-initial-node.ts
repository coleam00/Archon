import type { WorkflowStepStatus } from './types';

/**
 * Selects the initial DAG node to display when a workflow run loads.
 * Prefers a currently active node; falls back to the first node.
 */
export function selectInitialNode(
  nodes: { nodeId: string; status: WorkflowStepStatus }[] | undefined
): string | null {
  if (!nodes || nodes.length === 0) return null;
  const active = nodes.find(n => n.status === 'running' || n.status === 'queued');
  return active ? active.nodeId : nodes[0].nodeId;
}
