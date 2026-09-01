import { isIncludeDirective } from './schemas/dag-node';
import type { DagNode, IncludeDirective, LoopGroupNodeConfig } from './schemas/dag-node';
import type { GraphPlan, ResolvedWorkflow, WorkflowDefinition } from './schemas/workflow';

function requireResolvedNodes(nodes: readonly (DagNode | IncludeDirective)[]): DagNode[] {
  const resolved: DagNode[] = [];
  for (const node of nodes) {
    if (isIncludeDirective(node)) {
      throw new Error(
        `Internal error: include node '${node.id}' reached a resolved graph unexpanded. ` +
          'Include nodes must be resolved by expandWorkflowIncludes() during discovery.'
      );
    }
    resolved.push(node);
  }
  return resolved;
}

function planResolvedNodes(nodes: readonly DagNode[]): GraphPlan {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, node.depends_on?.length ?? 0);
    for (const dependency of node.depends_on ?? []) {
      const existing = dependents.get(dependency) ?? [];
      existing.push(node.id);
      dependents.set(dependency, existing);
    }
  }

  const layers: DagNode[][] = [];
  let ready = [...nodes].filter(node => (inDegree.get(node.id) ?? 0) === 0);

  while (ready.length > 0) {
    layers.push(ready);
    const nextIds: string[] = [];
    for (const node of ready) {
      for (const dependentId of dependents.get(node.id) ?? []) {
        const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
        inDegree.set(dependentId, nextDegree);
        if (nextDegree === 0) nextIds.push(dependentId);
      }
    }
    ready = nextIds
      .map(id => nodes.find(node => node.id === id))
      .filter((node): node is DagNode => node !== undefined);
  }

  const totalPlaced = layers.reduce((sum, layer) => sum + layer.length, 0);
  if (totalPlaced < nodes.length) {
    throw new Error('[GraphPlan] Cycle detected while planning workflow graph');
  }

  const dependencies = new Set(nodes.flatMap(node => node.depends_on ?? []));
  const sinks = nodes.filter(node => !dependencies.has(node.id)).map(node => node.id);
  return { nodes, layers, sinks };
}

/** Plan an already-authored node set, rejecting any include directive that survived expansion. */
export function planGraph(nodes: readonly (DagNode | IncludeDirective)[]): GraphPlan {
  return planResolvedNodes(requireResolvedNodes(nodes));
}

/** Construct the include-free workflow shape accepted by execution boundaries. */
export function resolveWorkflow(definition: WorkflowDefinition): ResolvedWorkflow {
  const plan = planResolvedNodes(requireResolvedNodes(definition.nodes));
  const resolved = { ...definition, nodes: plan.nodes, plan };
  Object.defineProperties(resolved, {
    nodes: { enumerable: true, get: () => plan.nodes },
    plan: { enumerable: true, value: plan },
  });
  // This constructor is the sole attachment point for the private type identity.
  return resolved as ResolvedWorkflow;
}

/** Narrow an expanded loop-group body at its shared execution boundary. */
export function resolvedBodyNodes(group: LoopGroupNodeConfig): readonly DagNode[] {
  return requireResolvedNodes(group.nodes);
}
