import { missingProviderMessage } from '@archon/provider-contract';
import type { ProviderRegistry } from '@archon/provider-contract';
import type { DagNode, IncludeDirective } from '../schemas';
import {
  isIncludeDirective,
  isLoopGroupNode,
  isNodeContextResume,
  nodeUsesPersistedScope,
  persistedSessionHandling,
} from '../schemas';
import { getLog } from './log';

// Provider identity is validated at load time, both at the workflow level and per node.
// Model strings are NOT validated — they pass through to the SDK at run time, which is the
// source of truth for what model names exist (vendor SDKs ship new models faster than
// Archon can update).

/** The error for the first provider the registry does not know, workflow level first. */
export function unknownProviderError(
  provider: string | undefined,
  dagNodes: readonly (DagNode | IncludeDirective)[],
  providers: ProviderRegistry
): string | null {
  if (provider && !providers.get(provider)) {
    return missingProviderMessage(providers, provider);
  }
  for (const node of dagNodes) {
    if (isIncludeDirective(node)) continue;
    if (node.provider !== undefined && !providers.get(node.provider)) {
      return `Node '${node.id}': ${missingProviderMessage(providers, node.provider)}`;
    }
  }
  return null;
}

interface SessionNode {
  node: DagNode;
  provider: string | undefined;
}

interface SessionConsumer {
  consumer: SessionNode;
  sources: ReadonlyMap<string, SessionNode>;
}

/** Record every `context.resume` consumer with the nodes in scope for it, loop_group bodies included. */
function collectSessionNodes(
  nodes: readonly (DagNode | IncludeDirective)[],
  inheritedProvider: string | undefined,
  sessionConsumers: SessionConsumer[],
  enclosing = new Map<string, SessionNode>()
): void {
  const scope = new Map(enclosing);
  for (const node of nodes) {
    if (!isIncludeDirective(node))
      scope.set(node.id, { node, provider: node.provider ?? inheritedProvider });
  }
  for (const node of nodes) {
    if (isIncludeDirective(node)) continue;
    const consumer = scope.get(node.id);
    if (consumer === undefined) continue;
    if (isNodeContextResume(node.context)) sessionConsumers.push({ consumer, sources: scope });
    if (isLoopGroupNode(node))
      collectSessionNodes(node.loop_group.nodes, consumer.provider, sessionConsumers, scope);
  }
}

/**
 * The error for the first `context.resume` whose source runs on a different known provider,
 * or whose known provider cannot fork a session.
 */
export function sessionResumeProviderError(
  dagNodes: readonly (DagNode | IncludeDirective)[],
  provider: string | undefined,
  providers: ProviderRegistry
): string | null {
  const sessionConsumers: SessionConsumer[] = [];
  collectSessionNodes(dagNodes, provider, sessionConsumers);
  for (const { consumer, sources } of sessionConsumers) {
    const error = sessionConsumerError(consumer, sources, providers);
    if (error !== null) return error;
  }
  return null;
}

function sessionConsumerError(
  { node, provider: consumerProvider }: SessionNode,
  sources: ReadonlyMap<string, SessionNode>,
  providers: ProviderRegistry
): string | null {
  if (!isNodeContextResume(node.context)) return null;
  const sourceEntry = sources.get(node.context.resume);
  if (sourceEntry === undefined) return null;
  const source = sourceEntry.node;
  const sourceProvider = sourceEntry.provider;
  if (
    consumerProvider !== undefined &&
    sourceProvider !== undefined &&
    consumerProvider !== sourceProvider
  ) {
    return `Node '${node.id}' context.resume source '${source.id}' uses provider '${sourceProvider}', but the consumer uses '${consumerProvider}'`;
  }

  const knownProvider = consumerProvider ?? sourceProvider;
  const knownDescriptor = knownProvider === undefined ? undefined : providers.get(knownProvider);
  if (knownDescriptor) {
    const caps = knownDescriptor.capabilities;
    if (!caps.sessionResume || caps.sessionFork !== true) {
      return `Node '${node.id}' context.resume requires immutable session forks, but provider '${knownProvider}' does not support sessionFork`;
    }
  }
  return null;
}

/**
 * persist_session capability gating: when the effective provider is known at
 * load time (explicit at node or workflow level), reject a provider without session
 * resume, and warn for one that cannot fork: the executor never continues its
 * persisted session, so each run of that node starts fresh. Both outcomes come from
 * `persistedSessionHandling`, the same answer the executor acts on. When the
 * provider is implicit (set via .archon/config.yaml defaults), the check defers to
 * runtime in agent dispatch (dag/nodes/agent/dispatch.ts).
 *
 * `nodeUsesPersistedScope` skips nodes that never use a persisted session (non-agent
 * nodes, context: 'fresh'), so workflow-level `persist_sessions: true` next to,
 * e.g., a bash node does not fail validation.
 */
export function persistSessionError(
  dagNodes: readonly (DagNode | IncludeDirective)[],
  workflowPersistSessions: boolean,
  provider: string | undefined,
  providers: ProviderRegistry,
  warnings: string[]
): string | null {
  for (const node of dagNodes) {
    const error = persistSessionNodeError(
      node,
      workflowPersistSessions,
      provider,
      providers,
      warnings
    );
    if (error !== null) return error;
  }
  return null;
}

function persistSessionNodeError(
  node: DagNode | IncludeDirective,
  workflowPersistSessions: boolean,
  provider: string | undefined,
  providers: ProviderRegistry,
  warnings: string[]
): string | null {
  if (isIncludeDirective(node)) return null;
  if (!nodeUsesPersistedScope(node, workflowPersistSessions)) return null;

  const explicitProvider = ('provider' in node ? node.provider : undefined) ?? provider;
  const descriptor = explicitProvider ? providers.get(explicitProvider) : undefined;
  if (!descriptor) return null;
  const handling = persistedSessionHandling(descriptor.capabilities);
  if (handling === 'unsupported') {
    return `Node '${node.id}' has persist_session: true but provider '${explicitProvider}' does not support sessionResume. Remove persist_session, or use a provider with sessionResume capability.`;
  }
  if (handling === 'fresh') {
    const message = `Node '${node.id}': provider '${explicitProvider}' cannot fork a session, so persist_session never continues an earlier run's session and every run starts fresh. Use a provider with sessionFork, or pass state between runs through artifacts.`;
    warnings.push(message);
    getLog().debug({ id: node.id, provider: explicitProvider }, 'persist_session_not_continued');
  }
  return null;
}
