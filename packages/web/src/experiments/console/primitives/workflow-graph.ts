/**
 * Workflow DAG primitives — just enough to render a compact graph in the
 * run-detail sidebar. We don't need the full `DagNode` shape from the
 * production API; we only care about id + dependencies + kind + status.
 */

import type { RunNodeState } from './event';

export type WorkflowNodeKind =
  | 'prompt'
  | 'command'
  | 'bash'
  | 'script'
  | 'approval'
  | 'wait'
  | 'loop'
  | 'cancel';

export type WorkflowNodeStatus = RunNodeState['state'];

export interface WorkflowGraphNode {
  id: string;
  dependsOn: string[];
  kind: WorkflowNodeKind;
}

export interface WorkflowGraphNodeWithStatus extends WorkflowGraphNode {
  status: WorkflowNodeStatus;
}

/**
 * Attach the engine's state to each graph node. A node the engine has not
 * listed has not been reached, which the engine itself reports as `pending`.
 */
export function deriveNodeStatuses(
  graphNodes: WorkflowGraphNode[],
  nodes: readonly RunNodeState[]
): WorkflowGraphNodeWithStatus[] {
  const stateById = new Map(nodes.map(n => [n.node_id, n.state]));
  return graphNodes.map(n => ({ ...n, status: stateById.get(n.id) ?? 'pending' }));
}
