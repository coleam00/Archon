import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import type { BuilderNode } from '../../nodes/shared/types';
import type { DagNodeData } from '../../nodes/shared/types';

export type { DagNodeData };

export interface DeriveFlowResult {
  rfNodes: RFNode<DagNodeData>[];
  rfEdges: RFEdge[];
}

/**
 * Edges carry a `data.dashed` flag so the custom edge component can render
 * the dashed style for `when:`-conditional edges without re-reading the
 * target node. Typed as a record so @xyflow/react's `Edge<TData>` constraint
 * (`Record<string, unknown> | undefined`) accepts it.
 */
export type DeletableEdgeData = Record<string, unknown> & {
  dashed: boolean;
};

export function deriveFlow(
  storeNodes: readonly BuilderNode[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  selectedNodeIds: ReadonlySet<string> = new Set(),
  selectedEdgeId: string | null = null
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
      const id = `${source}->${target.id}`;
      const isSelected = id === selectedEdgeId;
      rfEdges.push({
        id,
        source,
        target: target.id,
        type: 'deletable',
        selected: isSelected,
        data: { dashed: targetHasWhen } satisfies DeletableEdgeData,
        style: {
          stroke: isSelected
            ? 'var(--studio-accent, #3b82f6)'
            : targetHasWhen
              ? 'var(--studio-when)'
              : 'var(--studio-muted)',
          strokeWidth: isSelected ? 2.5 : 1.5,
          ...(targetHasWhen ? { strokeDasharray: '6 4' } : {}),
        },
      });
    }
  }

  return { rfNodes, rfEdges };
}
