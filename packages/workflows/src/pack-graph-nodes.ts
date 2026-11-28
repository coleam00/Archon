/**
 * A pack graph's nodes: each stage's nodes under the step names its runs record, and the
 * bodies its fan-out includes reach (`pack-graph.ts` serves both).
 */
import { readComposedMeta } from './compiled-command';
import { loopBodyStepNamePrefix, resolvedBodyNodes } from './graph-plan';
import type { PackGraph, Stage } from './pack-graph';
import { isComposeFanOutNode, isLoopGroupNode } from './schemas/node-guards';

type GraphNode = PackGraph['stages'][number]['nodes'][number];

/**
 * A stage's nodes, with each loop group's body after the group, recursively. Body nodes
 * take the step names the engine runs them under (`loopBodyStepNamePrefix`).
 */
export function stageNodes(stage: Pick<Stage, 'nodes'>, group: string | null = null): GraphNode[] {
  const prefix = group === null ? '' : loopBodyStepNamePrefix(group);
  return stage.nodes.flatMap(node => {
    const id = prefix + node.id;
    const graphNode: GraphNode = {
      id,
      kind: node.kind,
      // The loader checks a body node's `depends_on` against its own body, so every one is a sibling.
      dependsOn: (node.depends_on ?? []).map(dep => prefix + dep),
      loopGroup: group,
      blocks: (readComposedMeta(node)?.boundaries ?? []).map(({ boundary }) => ({
        include: boundary.includeId,
        workflow: boundary.workflow,
      })),
      fanOut: isComposeFanOutNode(node) ? { workflow: node.include } : null,
      ...(node.display === undefined ? {} : { display: node.display }),
    };
    return isLoopGroupNode(node)
      ? [graphNode, ...stageNodes({ nodes: resolvedBodyNodes(node.loop_group) }, id)]
      : [graphNode];
  });
}

/**
 * The body of every fan-out include reachable from the stages, resolved by name among
 * `workflows` as discovery resolved it, and the bodies those bodies fan out to.
 */
export function fanOutBlocks(
  stages: readonly Pick<Stage, 'nodes'>[],
  workflows: readonly Pick<Stage, 'name' | 'nodes'>[]
): PackGraph['fanOutBlocks'] {
  const blocks: PackGraph['fanOutBlocks'] = [];
  const pending = stages.flatMap(stage => stageNodes(stage));
  for (let node = pending.shift(); node !== undefined; node = pending.shift()) {
    const name = node.fanOut?.workflow;
    if (name === undefined || blocks.some(block => block.workflow === name)) continue;
    // Discovery has already qualified an installed pack's include to its own full name.
    const body = workflows.find(w => w.name === name);
    // Discovery refuses a fan-out whose target does not resolve, so this is a caller's bug.
    if (body === undefined)
      throw new Error(`Fan-out include '${name}' is not a discovered workflow`);
    const nodes = stageNodes(body);
    blocks.push({ workflow: name, nodes });
    pending.push(...nodes);
  }
  return blocks;
}
