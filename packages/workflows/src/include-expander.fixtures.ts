import { resolvedBodyNodes } from './graph-plan';
import { dagNodeSchema } from './schemas';
import type { WorkflowDefinition, ResolvedWorkflow, DagNode } from './schemas';
import {
  COMPILED_LOOP_COMMAND,
  COMPOSED_NODE,
  readComposedBindings,
  type ComposedBindings,
  type ComposedBlockBoundary,
  type ComposedNodeMeta,
  type LoopWithCompiledCommand,
  type NodeWithComposedMeta,
} from './compiled-command';

export function wf(
  name: string,
  nodes: unknown[],
  options: Partial<Omit<WorkflowDefinition, 'name' | 'nodes'>> = {}
): WorkflowDefinition {
  return {
    name,
    description: `${name} description`,
    ...options,
    nodes: nodes.map(n => dagNodeSchema.parse(n)),
  };
}

export function mapOf(...workflows: WorkflowDefinition[]): Map<string, WorkflowDefinition> {
  return new Map(workflows.map(w => [w.name, w]));
}

export function nodeById(w: ResolvedWorkflow, id: string): DagNode | undefined {
  return w.nodes.find(node => node.id === id);
}

function composedMeta(node: DagNode | undefined): ComposedNodeMeta | undefined {
  return node === undefined ? undefined : (node as DagNode & NodeWithComposedMeta)[COMPOSED_NODE];
}

export function composedInputs(node: DagNode | undefined): Record<string, unknown> | undefined {
  return composedMeta(node)?.inputs;
}

export function composedOrigin(node: DagNode | undefined): string | undefined {
  return composedMeta(node)?.origin;
}

export function composedBoundaries(node: DagNode | undefined): ComposedBlockBoundary[] | undefined {
  return composedMeta(node)?.boundaries;
}

export function composedBindings(node: DagNode | undefined): ComposedBindings | undefined {
  return node === undefined ? undefined : readComposedBindings(node);
}

export function compiledLoopPrompt(node: DagNode | undefined): string | undefined {
  if (!node || !('loop' in node)) return undefined;
  return (node.loop as typeof node.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND]?.prompt;
}

export function loopGroupOf(
  node: DagNode | undefined
): { nodes: DagNode[]; until_bash?: string } | undefined {
  if (!node || !('loop_group' in node)) return undefined;
  return { ...node.loop_group, nodes: [...resolvedBodyNodes(node.loop_group)] };
}

export function loopGroupNodes(node: DagNode | undefined): DagNode[] | undefined {
  return loopGroupOf(node)?.nodes;
}

export function inlinePrompt(node: DagNode | undefined): string | undefined {
  return node && 'source' in node && node.source.kind === 'inline' ? node.source.prompt : undefined;
}

export function bashScript(node: DagNode | undefined): string | undefined {
  return node && 'script' in node && node.runtime === 'sh' ? node.script : undefined;
}

export function blockWorkflow(): WorkflowDefinition {
  return wf('blk', [
    { id: 'verify', bash: 'echo verify' },
    { id: 'scope', prompt: 'scope $verify.output', depends_on: ['verify'] },
    { id: 'impl', prompt: 'implement', depends_on: ['scope'] },
  ]);
}
