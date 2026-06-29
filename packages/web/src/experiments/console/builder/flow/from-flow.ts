/**
 * xyflow nodes/edges → `BuilderWorkflow`. The inverse of `builderToFlow`:
 * rebuilds each node's `depends_on` from the edge list (target ← source, in
 * edge order) and strips positions back out, yielding a clean data-layer
 * workflow that PR-1's `toWorkflowDefinition` serializes.
 */
import type { BuilderNode, BuilderWorkflow } from '../types';
import type { BuilderFlowEdge, BuilderFlowNode } from './types';

/**
 * Reconstruct a `BuilderWorkflow` from canvas state.
 *
 * `prior` supplies the workflow-level fields the canvas does not carry (name,
 * description, meta) and lets dangling `depends_on` refs survive the round
 * trip: a dep pointing at a node id that does not exist on the canvas was
 * never representable as an edge (builderToFlow skips it), so it is carried
 * over from the prior workflow instead of being silently dropped — validation
 * owns flagging it.
 */
export function flowToBuilder(
  nodes: readonly BuilderFlowNode[],
  edges: readonly BuilderFlowEdge[],
  prior: BuilderWorkflow
): BuilderWorkflow {
  const canvasIds = new Set(nodes.map(n => n.id));
  const priorById = new Map(prior.nodes.map(n => [n.id, n]));

  const sourcesByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    const list = sourcesByTarget.get(edge.target);
    if (list === undefined) {
      sourcesByTarget.set(edge.target, [edge.source]);
    } else {
      list.push(edge.source);
    }
  }

  const rebuilt: BuilderNode[] = nodes.map(flowNode => {
    const node = flowNode.data.node;
    const fromEdges = sourcesByTarget.get(flowNode.id) ?? [];
    const dangling = (priorById.get(flowNode.id)?.base.depends_on ?? []).filter(
      dep => !canvasIds.has(dep)
    );
    const depends = [...fromEdges, ...dangling];
    return {
      ...node,
      base: { ...node.base, depends_on: depends.length > 0 ? depends : undefined },
    } as BuilderNode;
  });

  return {
    name: prior.name,
    description: prior.description,
    meta: prior.meta,
    nodes: rebuilt,
  };
}
