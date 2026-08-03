/**
 * Local dagre layout helper. A reimplementation of the production
 * `@/lib/dag-layout` pattern (rankdir TB, ranksep 80, nodesep 40) — the console
 * isolation guard means production web modules cannot be imported, so the
 * builder owns its own copy. Pure: returns a position map, mutates nothing.
 */
import dagre from '@dagrejs/dagre';
import type { XYPosition } from './types';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 80;

/**
 * Compute top-to-bottom dagre positions for a DAG. Edges referencing unknown
 * node ids are skipped (dagre would otherwise invent phantom nodes for them).
 * Dagre does not throw on cyclic input (it breaks cycles internally), so any
 * exception here is a real bug and propagates — no silent fallback.
 */
export function layoutWithDagre(
  nodeIds: readonly string[],
  edges: readonly { source: string; target: string }[]
): Map<string, XYPosition> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 80, nodesep: 40 });

  for (const id of nodeIds) {
    g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  const known = new Set(nodeIds);
  for (const edge of edges) {
    if (known.has(edge.source) && known.has(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  const positions = new Map<string, XYPosition>();
  for (const id of nodeIds) {
    const pos = g.node(id) as { x: number; y: number } | undefined;
    if (pos === undefined) continue;
    // dagre positions by center; xyflow positions by top-left corner.
    positions.set(id, { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 });
  }
  return positions;
}
