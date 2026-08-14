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

/** Map a `BuilderWorkflow` (+ saved positions) to xyflow nodes and edges. `ghosts`, when
 *  supplied, tags each matching node's data so `BuilderNodeView` can render the Builder
 *  Copilot's Proposal overlay (add/changed/remove) without a separate render path. */
export function builderToFlow(
  bw: BuilderWorkflow,
  positions?: ReadonlyMap<string, XYPosition>,
  selectedNodeIds: ReadonlySet<string> = new Set(),
  ghosts?: ReadonlyMap<string, 'add' | 'changed' | 'remove'>,
  edgeGhosts?: ReadonlyMap<string, 'add' | 'remove'>
): { nodes: BuilderFlowNode[]; edges: BuilderFlowEdge[] } {
  const baseEdges = builderToFlowEdges(bw);
  // Restyle proposed connections so an added link reads as provisional and a
  // dropped one stays visible while struck, matching the node ghost vocabulary.
  const edges =
    edgeGhosts === undefined || edgeGhosts.size === 0
      ? baseEdges
      : baseEdges.map(e => {
          const kind = edgeGhosts.get(e.id);
          if (kind === undefined) return e;
          return kind === 'add'
            ? {
                ...e,
                animated: true,
                style: { stroke: 'var(--accent-bright)', strokeDasharray: '6 4' },
              }
            : { ...e, style: { stroke: 'var(--error)', strokeDasharray: '2 4', opacity: 0.6 } };
        });

  const needsLayout = bw.nodes.some(n => !positions?.has(n.id));
  const computed = needsLayout
    ? layoutWithDagre(
        bw.nodes.map(n => n.id),
        edges.map(e => ({ source: e.source, target: e.target }))
      )
    : undefined;

  const nodes: BuilderFlowNode[] = bw.nodes.map(node => {
    // dagre lays out every node when any position is missing, so the origin
    // fallback is a defensive last resort. If it ever fires, a node would stack
    // at (0,0) — make that visible rather than silently overlapping nodes.
    const position = positions?.get(node.id) ?? computed?.get(node.id);
    if (position === undefined) {
      // Dev-visibility for an unreachable layout gap (dagre lays out all nodes).
      console.warn(
        `[builder] node '${node.id}' has no saved or computed position; placing at origin`
      );
    }
    return {
      id: node.id,
      type: BUILDER_NODE_TYPE,
      position: position ?? { x: 0, y: 0 },
      selected: selectedNodeIds.has(node.id),
      // Seed dimensions so consumers that read node size (the MiniMap, fitView
      // bounds) have values even though this is a *controlled* graph: our
      // onNodesChange forwards only select/position changes and drops xyflow's
      // `dimensions` changes, so `measured` never lands on these nodes and the
      // MiniMap would otherwise skip every node (nodeHasDimensions === false).
      // initialWidth/Height only seed — the live DOM measurement still drives
      // the node's real rendered height on the canvas.
      initialWidth: NODE_WIDTH,
      initialHeight: NODE_HEIGHT,
      data: { node, label: VARIANT_REGISTRY[node.variant].label, ghost: ghosts?.get(node.id) },
    };
  });

  return { nodes, edges };
}
