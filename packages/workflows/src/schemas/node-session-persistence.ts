import type { ProviderCapabilities } from '@archon/provider-contract';
import type { DagNode } from './dag-node';
import type { IncludeDirective } from './include-node';
import { isIncludeDirective } from './node-guards';

/**
 * True for node types that invoke a provider and therefore participate in cross-run
 * session persistence (`persist_session`). exec, gate, halt, loop, and loop_group
 * nodes are excluded — they either make no provider call or manage their own
 * per-iteration sessions. Shared by the loader's load-time capability gate and any
 * other caller that needs to reason about persistence eligibility, so the
 * exclusion list lives in one place.
 */
export function isPersistableNode(node: DagNode): boolean {
  return node.kind === 'agent';
}

/**
 * True when a node participates in cross-run session persistence: a persistable node
 * that hasn't opted out via `context: 'fresh'`, with `persist_session: true` set
 * directly or inherited from the workflow-level `persist_sessions` default. The
 * loader's capability check, the executor's session lookup and upsert, the #1846
 * scope-artifact mirror, and `runMayPersistSessions` all gate on this one predicate.
 */
export function nodeUsesPersistedScope(node: DagNode, workflowPersistSessions: boolean): boolean {
  if (!isPersistableNode(node)) return false;
  if (node.context === 'fresh') return false;
  const nodePersist = 'persist_session' in node ? node.persist_session : undefined;
  return nodePersist ?? workflowPersistSessions;
}

/**
 * True when a run of this workflow may use cross-run session persistence: some node
 * uses it, or a composed fan-out could, since its body resolves only when it runs.
 * The executor's run-start session read, the scope-artifact dir, and run telemetry
 * all gate on this.
 */
export function runMayPersistSessions(workflow: {
  nodes: readonly (DagNode | IncludeDirective)[];
  persist_sessions?: boolean;
}): boolean {
  const workflowPersistSessions = workflow.persist_sessions === true;
  return workflow.nodes.some(
    node =>
      !isIncludeDirective(node) &&
      (node.kind === 'compose_fan_out' || nodeUsesPersistedScope(node, workflowPersistSessions))
  );
}

/**
 * What a provider does with a session an earlier run persisted. Only a fork gives the
 * run its own copy; a provider that resumes in place would let two concurrent runs
 * write into one conversation, so its node starts fresh instead (`'fresh'`). The
 * loader warns on `'fresh'` and rejects `'unsupported'`; the executor continues only
 * on `'fork'`.
 */
export function persistedSessionHandling(
  caps: Pick<ProviderCapabilities, 'sessionResume' | 'sessionFork'>
): 'unsupported' | 'fresh' | 'fork' {
  if (!caps.sessionResume) return 'unsupported';
  return caps.sessionFork === true ? 'fork' : 'fresh';
}
