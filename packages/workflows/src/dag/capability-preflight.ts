import {
  type ExecutionContext,
  type ProviderRegistry,
  type PreparedStrictSchemaIssue,
  findPreparedStrictSchemaIssues,
} from '@archon/provider-contract';
import {
  type AgentNode,
  type DagNode,
  type GateNode,
  type IncludeDirective,
  type LoopGroupNode,
  type LoopNode,
  type ResolvedWorkflow,
  isOutputFormatEnforced,
} from '../schemas';
import type { ResolvedAiProfile } from '../model-validation';
import { resolveNodeModel, resolveNodeModelScope } from '../node-model-resolution';
import { gateReworkNode } from '../gate-rework';
import {
  type ScopedCapability,
  scopedCapabilityMismatchMessage,
  unsupportedScopedCapabilities,
} from './provider-resolution';

/**
 * How a node can reach a provider. Agent and loop nodes invoke one; a loop_group scopes
 * the provider its body inherits; an approval gate reaches one only through its
 * `on_reject` rework turn, carried here as the agent node that turn runs. Every other
 * kind is execution or coordination and never calls a provider.
 */
export type ProviderInvocation =
  | { kind: 'invokes'; node: AgentNode | LoopNode }
  | { kind: 'group'; node: LoopGroupNode }
  | { kind: 'gate_rework'; node: GateNode; rework: AgentNode }
  | { kind: 'none' };

/**
 * The one classification both preflight walkers select nodes by: the capability walker
 * below and the credential walker in run-preflight.ts. The switch is exhaustive, so a new
 * node kind does not compile until it is classified here.
 */
export function providerInvocation(node: DagNode | IncludeDirective): ProviderInvocation {
  switch (node.kind) {
    case 'agent':
    case 'loop':
      return { kind: 'invokes', node };
    case 'loop_group':
      return { kind: 'group', node };
    case 'gate': {
      const rework = node.decisions.find(d => d.rework !== undefined)?.rework;
      return rework
        ? { kind: 'gate_rework', node, rework: gateReworkNode(node, rework.prompt) }
        : { kind: 'none' };
    }
    case 'exec':
    case 'halt':
    case 'wait':
    case 'workflow':
    case 'compose_fan_out':
    case 'include':
      return { kind: 'none' };
  }
}

/**
 * Walk every node (including loop_group bodies) that can invoke a provider, as
 * {@link providerInvocation} classifies it. For each visited node the resolved provider
 * is passed to `visit`; a gate is visited with its rework turn's provider.
 * Unknown providers are passed through — the caller decides how to handle them.
 */
export function visitProviderInvokingNodes(
  nodes: readonly (DagNode | IncludeDirective)[],
  workflowProvider: string | undefined,
  aiProfile: ResolvedAiProfile | undefined,
  visit: (node: DagNode, provider: string) => void
): void {
  const resolve = (node: DagNode): string =>
    resolveNodeModel(
      node,
      {
        provider: workflowProvider,
        providerOrigin: 'workflow',
        model: undefined,
        preset: undefined,
        tier: undefined,
        effort: undefined,
      },
      {},
      aiProfile
    ).provider;
  for (const node of nodes) {
    const invocation = providerInvocation(node);
    switch (invocation.kind) {
      case 'none':
        break;
      case 'invokes':
        visit(invocation.node, resolve(invocation.node));
        break;
      case 'gate_rework':
        visit(invocation.node, resolve(invocation.rework));
        break;
      case 'group': {
        const group = invocation.node;
        const groupProvider = resolveNodeModelScope(
          group,
          {
            provider: workflowProvider,
            providerOrigin: 'workflow',
            model: undefined,
            preset: undefined,
            tier: undefined,
            effort: undefined,
          },
          {},
          aiProfile
        ).provider;
        if (groupProvider !== undefined) visit(group, groupProvider);
        visitProviderInvokingNodes(group.loop_group.nodes, groupProvider, aiProfile, visit);
        break;
      }
    }
  }
}

/**
 * Collect providers used by AI nodes that CANNOT run inside a container
 * (`capabilities.containerExec === false`), recursing loop_group bodies. bash/
 * script/cancel nodes are deterministic (they exec via `docker exec` directly,
 * no provider) and are skipped; an approval node counts only when it has an
 * `on_reject` reprompt (the one AI turn it can spawn). Unknown providers are
 * skipped here — they fail later with a clearer "unknown provider" error.
 */
export function collectContainerIncompatibleProviders(
  providers: ProviderRegistry,
  nodes: readonly DagNode[],
  workflowProvider: string | undefined,
  aiProfile?: ResolvedAiProfile
): Set<string> {
  const incompatible = new Set<string>();
  visitProviderInvokingNodes(nodes, workflowProvider, aiProfile, (_node, provider) => {
    const descriptor = providers.get(provider);
    if (descriptor && !descriptor.capabilities.containerExec) incompatible.add(provider);
  });
  return incompatible;
}

/** A node that names capabilities its resolved provider cannot honour. */
export interface ScopedCapabilityMismatch {
  nodeId: string;
  provider: string;
  capabilities: ScopedCapability[];
}

/**
 * Collect AI nodes that name `mcp:`, `skills:` or `plugins:` while their resolved
 * provider declares that capability `false`. Unknown providers are skipped here;
 * they fail later with a clearer "unknown provider" error.
 */
export function collectScopedCapabilityMismatches(
  providers: ProviderRegistry,
  nodes: readonly DagNode[],
  workflowProvider: string | undefined,
  aiProfile?: ResolvedAiProfile
): ScopedCapabilityMismatch[] {
  const mismatches: ScopedCapabilityMismatch[] = [];
  visitProviderInvokingNodes(nodes, workflowProvider, aiProfile, (node, provider) => {
    const descriptor = providers.get(provider);
    if (!descriptor) return;
    const capabilities = unsupportedScopedCapabilities(node, descriptor.capabilities);
    if (capabilities.length > 0) mismatches.push({ nodeId: node.id, provider, capabilities });
  });
  return mismatches;
}

/**
 * A single `output_format` issue on a provider that enforces OpenAI strict mode
 * (Codex). Reported by {@link collectStrictSchemaViolations} before any node runs.
 */
export type StrictSchemaViolation = PreparedStrictSchemaIssue & {
  /** The resolved provider that enforces the rule */
  provider: string;
  /** The node whose output_format violates the rule */
  nodeId: string;
};

/**
 * Collect output_format schema violations for providers that enforce the OpenAI
 * strict-mode object-schema rules (`requiresAllPropertiesRequired`). Walks every
 * provider-invoking node (including loop_group bodies) and reports every object
 * schema node that omits properties or does not list every property in required
 * after preparation. Unsupported conversions are also reported.
 *
 * A node pinned to a non-enforcing provider (e.g. `provider: claude`) is skipped
 * even when the workflow-level provider would enforce — that's the intended
 * opt-out: the workflow owner chose a provider that accepts optional-by-omission.
 */
export function collectStrictSchemaViolations(
  providers: ProviderRegistry,
  nodes: readonly (DagNode | IncludeDirective)[],
  workflowProvider: string | undefined,
  aiProfile?: ResolvedAiProfile
): StrictSchemaViolation[] {
  const violations: StrictSchemaViolation[] = [];
  visitProviderInvokingNodes(nodes, workflowProvider, aiProfile, (node, provider) => {
    if (!providers.get(provider)?.capabilities.requiresAllPropertiesRequired) return;
    // Only nodes whose output_format is enforced by the engine — gate/loop_group
    // schemas are inert even when present, so their issues cost nothing.
    if (!isOutputFormatEnforced(node)) return;
    if (node.output_format === undefined) return;
    for (const issue of findPreparedStrictSchemaIssues(node.output_format)) {
      violations.push({ provider, nodeId: node.id, ...issue });
    }
  });
  return violations;
}

/**
 * Refuse a run before ANY node runs, so no node spends (and no container work starts) in
 * a run that a later node would fail: a node whose MCP servers, skills or plugins cannot
 * load, a container run whose AI nodes resolve to a provider that cannot spawn in-container
 * (no silent downgrade to the host: the user asked for isolation and must get it or a
 * clear error), or an AI node whose `output_format` a strict provider rejects at its first
 * turn (OpenAI/Codex requires explicit object properties and complete required coverage;
 * this applies on the host too).
 */
export function assertRunCapabilities(
  providers: ProviderRegistry,
  workflow: Pick<ResolvedWorkflow, 'name' | 'nodes'>,
  workflowProvider: string | undefined,
  aiProfile: ResolvedAiProfile | undefined,
  execContext: ExecutionContext
): void {
  const capabilityMismatches = collectScopedCapabilityMismatches(
    providers,
    workflow.nodes,
    workflowProvider,
    aiProfile
  );
  if (capabilityMismatches.length > 0) {
    throw new Error(scopedCapabilityMismatchMessage(capabilityMismatches));
  }

  if (execContext.kind === 'container') {
    const incompatible = collectContainerIncompatibleProviders(
      providers,
      workflow.nodes,
      workflowProvider,
      aiProfile
    );
    if (incompatible.size > 0) {
      const list = [...incompatible].sort().join(', ');
      throw new Error(
        `Provider${incompatible.size === 1 ? '' : 's'} '${list}' cannot run inside a ` +
          'container yet (containerExec capability). Use provider claude, or run without ' +
          '--container.'
      );
    }
  }

  const violations = collectStrictSchemaViolations(
    providers,
    workflow.nodes,
    workflowProvider,
    aiProfile
  );
  if (violations.length === 0) return;
  const [first] = violations;
  const more = violations.length > 1 ? ` (+${violations.length - 1} more)` : '';
  const location =
    `output_format schema strict-mode violation: workflow '${workflow.name}', ` +
    `node '${first.nodeId}', ${first.schemaPath}`;
  if (first.kind === 'unsupported-conversion') {
    throw new Error(
      `${location}: Provider '${first.provider}' rejects this schema. ${first.message}${more}`
    );
  }
  if (first.kind === 'missing-properties') {
    throw new Error(
      `${location} is an object schema without 'properties'${more}. ` +
        `Provider '${first.provider}' (OpenAI strict mode) rejects it. ` +
        'Declare the object properties and list every property in required; ' +
        'use a nullable object (e.g. type: ["object","null"]) when the value may be absent.'
    );
  }
  throw new Error(
    `${location} declares ${first.missing.join(', ')} not in 'required'${more}. ` +
      `Provider '${first.provider}' (OpenAI strict mode) rejects it. ` +
      'List every property in required; express optionality in-type ' +
      '(e.g. a ["string","null"] union or an enum sentinel).'
  );
}
