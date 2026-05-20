import { useMemo } from 'react';
import dagre from '@dagrejs/dagre';

/** Mirrors Archon's `packages/web/src/lib/dag-layout.ts` settings at the pinned SHA. */
const DAGRE_OPTIONS = { rankdir: 'TB', ranksep: 80, nodesep: 40 } as const;
const NODE_WIDTH = 180;
const NODE_HEIGHT = 80;

interface MinimalRFNode {
  id: string;
  position: { x: number; y: number };
}
interface MinimalRFEdge {
  id: string;
  source: string;
  target: string;
}

/** Pure: compute dagre positions for the given graph. Caller decides what to do with them. */
export function layoutWithDagre(
  nodes: readonly MinimalRFNode[],
  edges: readonly MinimalRFEdge[]
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return result;

  const g = new dagre.graphlib.Graph();
  g.setGraph(DAGRE_OPTIONS);
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);

  try {
    dagre.layout(g);
  } catch (err) {
    // Cycle or other dagre failure — return identity positions; Canvas surfaces a warning.
    // (Phase 6's cycle detector is the authoritative gatekeeper; this is just a soft fallback.)

    console.error('[useDagre] layout failed, using identity positions:', err);
    for (const n of nodes) result.set(n.id, { x: 0, y: 0 });
    return result;
  }

  for (const n of nodes) {
    const laid = g.node(n.id);
    if (!laid) continue;
    // Dagre returns CENTER positions; React Flow expects TOP-LEFT.
    result.set(n.id, { x: laid.x - NODE_WIDTH / 2, y: laid.y - NODE_HEIGHT / 2 });
  }
  return result;
}

/** Memoised React wrapper. Re-runs only when the input identity changes. */
export function useDagre(
  nodes: readonly MinimalRFNode[],
  edges: readonly MinimalRFEdge[]
): Map<string, { x: number; y: number }> {
  return useMemo(() => layoutWithDagre(nodes, edges), [nodes, edges]);
}
