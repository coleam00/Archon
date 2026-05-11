/**
 * Selects the initial DAG node to display when a workflow run loads.
 * Prefers a currently running node; falls back to the first node.
 */
export function selectInitialNode(
  nodes: { nodeId: string; status: string }[] | undefined
): string | null {
  if (!nodes || nodes.length === 0) return null;
  const running = nodes.find(n => n.status === 'running');
  return running ? running.nodeId : nodes[0].nodeId;
}
