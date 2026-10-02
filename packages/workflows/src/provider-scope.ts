/**
 * Which provider each node of a workflow runs on, and which of those nodes send an
 * `output_format` to a provider that enforces OpenAI strict mode.
 *
 * The launch preflight (dag-executor.ts) and `archon validate workflows`
 * (validator.ts) both answer these questions, so both call this module. A second
 * copy of the provider inheritance or the node walk would let validation pass a
 * workflow that the preflight then refuses, or the reverse (#3558).
 *
 * Pure: no I/O, no messaging.
 */
import {
  findOpenAiStrictSchemaViolations,
  getProviderCapabilities,
  isRegisteredProvider,
  type OpenAiStrictSchemaViolation,
} from '@archon/providers';
import { isLiteralSpec, resolveModelSpec, type ResolvedAiProfile } from './model-validation';
import {
  isExecNode,
  isGateNode,
  isHaltNode,
  isIncludeDirective,
  isLoopGroupNode,
  isOutputFormatEnforced,
  isWaitNode,
  type DagNode,
  type IncludeDirective,
} from './schemas';

/**
 * The provider a node runs on: its own `provider`, else the one it inherits (the
 * workflow's, or its loop_group's), and then a tier or alias `model` ref may
 * override it. Throws when the profile cannot resolve the node's model ref.
 */
export function resolveNodeProvider<P extends string | undefined>(
  node: DagNode,
  inherited: P,
  aiProfile: ResolvedAiProfile | undefined
): string | P {
  const provider: string | P = node.provider !== undefined ? node.provider : inherited;
  if (!node.model || !aiProfile) return provider;
  const spec = resolveModelSpec(aiProfile, node.model);
  return isLiteralSpec(spec) ? provider : spec.provider;
}

/** Resolves one node's provider from the provider it inherits. */
export type NodeProviderResolver<P extends string | undefined> = (
  node: DagNode,
  inherited: string | P
) => string | P;

/**
 * Visit every node, loop_group bodies included, with the provider execution gives
 * it. A body node inherits its group's resolved provider. An include directive is
 * visited with the provider it would inherit and is never resolved.
 */
export function walkNodeProviders<P extends string | undefined>(
  nodes: readonly (DagNode | IncludeDirective)[],
  inherited: string | P,
  resolve: NodeProviderResolver<P>,
  visit: (node: DagNode | IncludeDirective, provider: string | P) => void
): void {
  for (const node of nodes) {
    if (isIncludeDirective(node)) {
      visit(node, inherited);
      continue;
    }
    const provider = resolve(node, inherited);
    visit(node, provider);
    if (isLoopGroupNode(node)) walkNodeProviders(node.loop_group.nodes, provider, resolve, visit);
  }
}

/**
 * True for a node that can start a provider turn. bash/script/cancel/wait nodes
 * never do. An approval node does only when it has an `on_reject` reprompt, the
 * one AI turn it can spawn. A loop_group counts: its body inherits its provider.
 */
function invokesProvider(node: DagNode): boolean {
  if (isExecNode(node) || isHaltNode(node) || isWaitNode(node)) return false;
  if (isGateNode(node)) return node.decisions.some(d => d.rework !== undefined);
  return true;
}

/**
 * Visit every node that can invoke a provider, with its resolved provider.
 * Unknown providers are passed through; the caller decides. Throws when such a
 * node's model ref cannot be resolved. A node that never invokes a provider is
 * not resolved, so its model ref cannot fail the walk.
 */
export function visitProviderInvokingNodes<P extends string | undefined>(
  nodes: readonly (DagNode | IncludeDirective)[],
  workflowProvider: P,
  aiProfile: ResolvedAiProfile | undefined,
  visit: (node: DagNode, provider: string | P) => void
): void {
  walkNodeProviders<P>(
    nodes,
    workflowProvider,
    (node, inherited) =>
      invokesProvider(node) ? resolveNodeProvider(node, inherited, aiProfile) : inherited,
    (node, provider) => {
      if (!isIncludeDirective(node) && invokesProvider(node)) visit(node, provider);
    }
  );
}

/**
 * A single `output_format` schema shape rejected by a provider that enforces
 * OpenAI strict mode (Codex).
 */
export type StrictSchemaViolation = OpenAiStrictSchemaViolation & {
  /** The resolved provider that enforces the rule */
  provider: string;
  /** The node whose output_format violates the rule */
  nodeId: string;
};

/**
 * Collect output_format schema violations for providers that enforce the OpenAI
 * strict-mode schema rule (`requiresAllPropertiesRequired`): object schemas that
 * declare no properties, or whose properties aren't all listed in `required`.
 *
 * A node pinned to a non-enforcing provider (e.g. `provider: claude`) is skipped
 * even when the workflow-level provider would enforce. That is the intended
 * opt-out: the workflow owner chose a provider that accepts optional-by-omission.
 * A node with no resolved provider is skipped too.
 *
 * Throws when a node's model ref cannot be resolved.
 */
export function collectStrictSchemaViolations(
  nodes: readonly (DagNode | IncludeDirective)[],
  workflowProvider: string | undefined,
  aiProfile?: ResolvedAiProfile
): StrictSchemaViolation[] {
  const violations: StrictSchemaViolation[] = [];
  visitProviderInvokingNodes(nodes, workflowProvider, aiProfile, (node, provider) => {
    if (provider === undefined || !isRegisteredProvider(provider)) return;
    if (!getProviderCapabilities(provider).requiresAllPropertiesRequired) return;
    // Only nodes whose output_format the engine enforces: gate and loop_group
    // schemas are inert even when present, so their violations cost nothing.
    if (!isOutputFormatEnforced(node)) return;
    if (node.output_format === undefined) return;
    for (const violation of findOpenAiStrictSchemaViolations(node.output_format, 'output_format')) {
      violations.push({ provider, nodeId: node.id, ...violation });
    }
  });
  return violations;
}
