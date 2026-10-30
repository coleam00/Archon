import type { ComposeFanOutNode, DagNode, IncludeDirective, LoopGroupNode } from '../schemas';
import { isComposeFanOutNode, isIncludeDirective, isLoopGroupNode } from '../schemas';

type StaticNode =
  | { kind: 'include'; node: IncludeDirective | ComposeFanOutNode }
  | { kind: 'group'; node: LoopGroupNode }
  | { kind: 'executable'; node: DagNode };

export function classifyStaticNode(node: DagNode | IncludeDirective): StaticNode {
  if (isIncludeDirective(node) || isComposeFanOutNode(node)) return { kind: 'include', node };
  if (isLoopGroupNode(node)) return { kind: 'group', node };
  return { kind: 'executable', node };
}

export function* walkStaticNodes(
  nodes: readonly (DagNode | IncludeDirective)[]
): Generator<StaticNode> {
  for (const node of nodes) {
    const classified = classifyStaticNode(node);
    yield classified;
    if (classified.kind === 'group') yield* walkStaticNodes(classified.node.loop_group.nodes);
  }
}
