/**
 * Workflow DAG primitives — just enough to render a compact graph in the
 * run-detail sidebar. We don't need the full `DagNode` shape from the
 * production API; we only care about id + dependencies + kind + status.
 */

export type WorkflowNodeKind = 'prompt' | 'command' | 'bash' | 'script' | 'approval' | 'loop';

export type WorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowGraphNode {
  id: string;
  dependsOn: string[];
  kind: WorkflowNodeKind;
}

export interface WorkflowGraphNodeWithStatus extends WorkflowGraphNode {
  status: WorkflowNodeStatus;
  durationMs: number | null;
}

import type { RunEvent } from './event';

/**
 * Derive each node's current status by walking run events in order.
 * Later events override earlier ones for the same node. Nodes with no
 * events stay `pending`.
 */
export function deriveNodeStatuses(
  nodes: WorkflowGraphNode[],
  events: RunEvent[]
): WorkflowGraphNodeWithStatus[] {
  const byNode = new Map<string, { status: WorkflowNodeStatus; durationMs: number | null }>();
  for (const e of events) {
    if (e.kind !== 'node_transition') continue;
    const name = e.nodeName;
    if (name.length === 0) continue;
    const status: WorkflowNodeStatus =
      e.transition === 'started'
        ? 'running'
        : e.transition === 'completed'
          ? 'completed'
          : e.transition === 'failed'
            ? 'failed'
            : 'skipped';
    byNode.set(name, { status, durationMs: e.durationMs });
  }
  return nodes.map(n => {
    const current = byNode.get(n.id);
    return {
      ...n,
      status: current?.status ?? 'pending',
      durationMs: current?.durationMs ?? null,
    };
  });
}
