/**
 * Workflow DAG primitives — just enough to render a compact graph in the
 * run-detail sidebar. We don't need the full `DagNode` shape from the
 * production API; we only care about id + dependencies + kind + status.
 */

import type { RunEvent, FanOutView } from './event';

export type WorkflowNodeKind =
  | 'prompt'
  | 'command'
  | 'bash'
  | 'script'
  | 'approval'
  | 'loop'
  | 'cancel'
  // A `workflow:` sub-run / fan-out node. Before #2451 it fell through to `prompt`, so a
  // fan-out `spread` node painted as a plain prompt dot in the graph.
  | 'workflow';

export type WorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowGraphNode {
  id: string;
  dependsOn: string[];
  kind: WorkflowNodeKind;
}

export interface WorkflowGraphNodeWithStatus extends WorkflowGraphNode {
  status: WorkflowNodeStatus;
  durationMs: number | null;
  /**
   * Fan-out tally (#2451) for a `workflow:` fan-out node whose terminal event carried a
   * child report; null otherwise. The graph paints AMBER attention (not a red `failed`
   * status) and a `completed/total` badge when `notCompleted > 0` — lifecycle stays
   * `completed`.
   */
  fanOut: FanOutView['tally'] | null;
}

/**
 * Derive each node's current status by walking run events in order.
 * Later events override earlier ones for the same node. Nodes with no
 * events stay `pending`. A fan-out node's derived tally is forwarded so the
 * graph can render amber attention without importing the parse (#2451).
 */
export function deriveNodeStatuses(
  nodes: WorkflowGraphNode[],
  events: RunEvent[]
): WorkflowGraphNodeWithStatus[] {
  const byNode = new Map<
    string,
    { status: WorkflowNodeStatus; durationMs: number | null; fanOut: FanOutView['tally'] | null }
  >();
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
    // The report only rides a terminal transition; keep any tally already seen for this node
    // if a later (e.g. resume-skipped) transition carries none.
    const prior = byNode.get(name);
    byNode.set(name, {
      status,
      durationMs: e.durationMs,
      fanOut: e.fanOut?.tally ?? prior?.fanOut ?? null,
    });
  }
  return nodes.map(n => {
    const current = byNode.get(n.id);
    return {
      ...n,
      status: current?.status ?? 'pending',
      durationMs: current?.durationMs ?? null,
      fanOut: current?.fanOut ?? null,
    };
  });
}
