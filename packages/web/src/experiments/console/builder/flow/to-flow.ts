/**
 * `BuilderWorkflow` → xyflow nodes/edges. Ported from the standalone studio's
 * `deriveFlow` (canvas/deriveFlow.ts), restyled with console tokens.
 *
 * Positions are UI-only state (PR-1's data layer has none): callers pass the
 * saved position map and any node missing from it falls back to a dagre layout
 * computed over the whole graph, so a freshly-imported workflow lays itself out.
 */
import { VARIANT_REGISTRY } from '../variants';
import type { BuilderWorkflow } from '../types';
import { layoutWithDagre, NODE_HEIGHT, NODE_WIDTH } from './layout';
import type { BuilderFlowEdge, BuilderFlowNode, XYPosition } from './types';

/** The xyflow `nodeTypes` key every builder node renders under. */
export const BUILDER_NODE_TYPE = 'builderNode';

/** Stable edge id for a `depends_on` pair. */
export function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

/**
 * Synthesize the edge list from each node's `depends_on`. Dangling deps (ids
 * not present in the workflow) get no edge — they stay on the data-layer node
 * (and are flagged by validation) rather than becoming phantom canvas edges.
 * Edges into a node carrying a `when:` render dashed (conditional path).
 */
export function builderToFlowEdges(bw: BuilderWorkflow): BuilderFlowEdge[] {
  const known = new Set(bw.nodes.map(n => n.id));
  const edges: BuilderFlowEdge[] = [];
  for (const target of bw.nodes) {
    const hasWhen = typeof target.base.when === 'string' && target.base.when.length > 0;
    for (const source of target.base.depends_on ?? []) {
      if (!known.has(source)) continue;
      edges.push({
        id: edgeId(source, target.id),
        source,
        target: target.id,
        type: 'smoothstep',
        style: hasWhen
          ? { stroke: 'var(--text-tertiary)', strokeDasharray: '6 4' }
          : { stroke: 'var(--border-bright)' },
      });
    }
  }
  return edges;
}

/** Map a `BuilderWorkflow` (+ saved positions) to xyflow nodes and edges. */
export function builderToFlow(
  bw: BuilderWorkflow,
  positions?: ReadonlyMap<string, XYPosition>,
  selectedNodeIds: ReadonlySet<string> = new Set()
): { nodes: BuilderFlowNode[]; edges: BuilderFlowEdge[] } {
  const edges = builderToFlowEdges(bw);

  const needsLayout = bw.nodes.some(n => !positions?.has(n.id));
  const computed = needsLayout
    ? layoutWithDagre(
        bw.nodes.map(n => n.id),
        edges.map(e => ({ source: e.source, target: e.target }))
      )
    : undefined;

  const nodes: BuilderFlowNode[] = bw.nodes.map(node => ({
    id: node.id,
    type: BUILDER_NODE_TYPE,
    position: positions?.get(node.id) ?? computed?.get(node.id) ?? { x: 0, y: 0 },
    selected: selectedNodeIds.has(node.id),
    // Seed dimensions so consumers that read node size (the MiniMap, fitView
    // bounds) have values even though this is a *controlled* graph: our
    // onNodesChange forwards only select/position changes and drops xyflow's
    // `dimensions` changes, so `measured` never lands on these nodes and the
    // MiniMap would otherwise skip every node (nodeHasDimensions === false).
    // initialWidth/Height only seed — the live DOM measurement still drives the
    // node's real rendered height on the canvas.
    initialWidth: NODE_WIDTH,
    initialHeight: NODE_HEIGHT,
    data: { node, label: VARIANT_REGISTRY[node.variant].label },
  }));

  return { nodes, edges };
}
