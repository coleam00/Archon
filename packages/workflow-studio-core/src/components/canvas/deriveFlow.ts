import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import type { BuilderNode } from '../../nodes/shared/types';
import type { DagNodeData } from '../../nodes/shared/types';

export type { DagNodeData };

export interface DeriveFlowResult {
  rfNodes: RFNode<DagNodeData>[];
  rfEdges: RFEdge[];
}

export function deriveFlow(
  storeNodes: readonly BuilderNode[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  selectedNodeIds: ReadonlySet<string> = new Set()
): DeriveFlowResult {
  const knownIds = new Set(storeNodes.map(n => n.id));

  const rfNodes: RFNode<DagNodeData>[] = storeNodes.map(n => ({
    id: n.id,
    type: n.variant,
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    selected: selectedNodeIds.has(n.id),
    data: { storeId: n.id, node: n },
  }));

  const rfEdges: RFEdge[] = [];
  for (const target of storeNodes) {
    const dep = target.base.depends_on as string[] | undefined;
    if (!dep) continue;
    const targetHasWhen = typeof target.base.when === 'string';
    for (const source of dep) {
      if (!knownIds.has(source)) continue; // defensive
      rfEdges.push({
        id: `${source}->${target.id}`,
        source,
        target: target.id,
        type: 'smoothstep',
        style: targetHasWhen
          ? { stroke: 'var(--studio-when)', strokeDasharray: '6 4' }
          : { stroke: 'var(--studio-muted)' },
      });
    }
  }

  return { rfNodes, rfEdges };
}
