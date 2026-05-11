import type { Edge } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import type { DagNode } from '@/lib/api';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 80;

export function layoutWithDagre(
  nodes: DagFlowNode[],
  edges: Edge[]
): { nodes: DagFlowNode[]; edges: Edge[] } {
  try {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'TB', ranksep: 80, nodesep: 40 });

    for (const node of nodes) {
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    for (const edge of edges) {
      g.setEdge(edge.source, edge.target);
    }

    dagre.layout(g);

    const layoutedNodes = nodes.map(node => {
      const pos = g.node(node.id) as { x: number; y: number } | undefined;
      if (!pos) return node;
      return {
        ...node,
        position: {
          x: pos.x - NODE_WIDTH / 2,
          y: pos.y - NODE_HEIGHT / 2,
        },
      };
    });

    return { nodes: layoutedNodes, edges };
  } catch (err) {
    console.error('[dag-layout] Dagre layout failed, using fallback positions:', err);
    return { nodes, edges };
  }
}

export function resolveNodeDisplay(dn: DagNode): {
  label: string;
  nodeType: 'command' | 'prompt' | 'bash';
  promptText?: string;
  bashScript?: string;
  bashTimeout?: number;
} {
  if ('bash' in dn && dn.bash) {
    return {
      label: 'Shell',
      nodeType: 'bash',
      bashScript: dn.bash,
      bashTimeout: dn.timeout,
    };
  }
  if ('command' in dn && dn.command) {
    return { label: dn.command, nodeType: 'command' };
  }
  return {
    label: 'Prompt',
    nodeType: 'prompt',
    promptText: dn.prompt,
  };
}

export function dagNodesToReactFlow(dagNodes: readonly DagNode[]): {
  nodes: DagFlowNode[];
  edges: Edge[];
} {
  const nodes: DagFlowNode[] = dagNodes.map((dn, i) => ({
    id: dn.id,
    type: 'dagNode',
    position: { x: 0, y: i * 100 },
    data: {
      ...dn,
      ...resolveNodeDisplay(dn),
    },
  }));

  const edges: Edge[] = [];
  for (const dn of dagNodes) {
    for (const dep of dn.depends_on ?? []) {
      edges.push({
        id: `${dep}->${dn.id}`,
        source: dep,
        target: dn.id,
        type: 'smoothstep',
      });
    }
  }

  const { nodes: layouted, edges: layoutedEdges } = layoutWithDagre(nodes, edges);
  return { nodes: layouted, edges: layoutedEdges };
}

/**
 * Check if the graph has a cycle using Kahn's algorithm.
 * Returns true if a cycle exists.
 */
export function hasCycle(
  nodeIds: Set<string>,
  edges: { source: string; target: string }[]
): boolean {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target) {
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
      adjacency.get(edge.source)?.push(edge.target);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    visited++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return visited < nodeIds.size;
}

/**
 * Compute topological layer index for each node using Kahn's algorithm (BFS).
 * Nodes with zero in-degree start at layer 0; each node's layer is the maximum
 * depth across all incoming paths (not simply parent + 1 for convergent paths).
 */
export function computeTopologicalLayers(nodes: DagFlowNode[], edges: Edge[]): Map<string, number> {
  const layers = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    const neighbors = adjacency.get(edge.source);
    if (neighbors) {
      neighbors.push(edge.target);
    }
  }

  // BFS from zero-in-degree nodes
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
      layers.set(nodeId, 0);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentLayer = layers.get(current) ?? 0;
    const neighbors = adjacency.get(current) ?? [];

    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);

      // Assign the maximum layer from all incoming paths
      const existingLayer = layers.get(neighbor);
      const candidateLayer = currentLayer + 1;
      if (existingLayer === undefined || candidateLayer > existingLayer) {
        layers.set(neighbor, candidateLayer);
      }

      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  return layers;
}
