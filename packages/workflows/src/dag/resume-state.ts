/**
 * The run state a DAG pass starts from: outputs of nodes a prior pass completed, the
 * cross-run session scopes (the launching thread's and the item's), and the provider sessions named resumes read.
 */
import type { WorkflowDeps } from '../deps';
import type {
  DagNode,
  NodeOutput,
  ResolvedWorkflow,
  WorkflowRun,
  WorkflowRunNodeSession,
} from '../schemas';
import {
  definedOutputPaths,
  isLoopGroupNode,
  isNodeContextResume,
  isNodeContextSame,
  persistScopeKey,
  runMayPersistSessions,
} from '../schemas';
import { resolvedBodyNodes } from '../graph-plan';
import type { PersistedNodeOutput } from '../store';
import { getLog } from './log';
import type { PersistScope, SequentialSessionCursor } from './run-context';

export interface RestoredRunState {
  nodeOutputs: Map<string, NodeOutput>;
  persistScope: PersistScope | undefined;
  itemScope: PersistScope | undefined;
  namedResumeSourceIds: ReadonlySet<string>;
  nodeSessionHandles: Map<string, SequentialSessionCursor>;
}

export function restoreRunState(
  store: WorkflowDeps['store'],
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput> | undefined,
  priorNodeSessions: readonly WorkflowRunNodeSession[] | undefined
): RestoredRunState {
  const nodeOutputs = priorNodeOutputs(workflow, workflowRun, priorCompletedNodes);
  const namedResumeSourceIds = collectNamedResumeSources(workflow.nodes);
  const nodeSessionHandles = new Map<string, SequentialSessionCursor>();
  for (const row of priorNodeSessions ?? []) {
    // The completed-output snapshot is the authority for which nodes actually
    // survived the previous pass. Never resurrect a handle without its completion.
    if (namedResumeSourceIds.has(row.node_id) && nodeOutputs.has(row.node_id)) {
      nodeSessionHandles.set(row.node_id, {
        sessionId: row.provider_session_id,
        provider: row.provider,
      });
    }
  }
  return {
    nodeOutputs,
    persistScope: openPersistScope(store, workflow, workflowRun),
    itemScope: openItemScope(store, workflow, workflowRun),
    namedResumeSourceIds,
    nodeSessionHandles,
  };
}

/**
 * Pre-populate nodeOutputs from prior run so already-completed nodes are
 * treated as done for trigger-rule and $nodeId.output substitution purposes.
 * Nodes flagged `always_run: true` are excluded — they re-execute on resume
 * and downstream consumers must see the fresh output, not the cached one.
 */
function priorNodeOutputs(
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput> | undefined
): Map<string, NodeOutput> {
  const nodeOutputs = new Map<string, NodeOutput>();
  if (!priorCompletedNodes || priorCompletedNodes.size === 0) return nodeOutputs;
  const nodesById = new Map(workflow.nodes.map(n => [n.id, n]));
  let prepopulatedCount = 0;
  for (const [nodeId, prior] of priorCompletedNodes) {
    const node = nodesById.get(nodeId);
    if (node?.always_run) continue;
    // A local producer's loaded definition owns its contract, so its strict
    // `$node.output.<path>` contract survives resume (#2091) and matches the load-time
    // check, even when the row was written by an older binary that recorded only
    // top-level fields. The persisted contract serves producers whose definition states
    // none: a `workflow:` node's is the CHILD's (#2453), and a wait node's is fixed by
    // the engine. A loop_group gets none: its output_format is ignored, but its
    // persisted terminal payload (below) still rehydrates, matching fresh completion
    // since #2637.
    const declaredOutputPaths =
      (node !== undefined ? definedOutputPaths(node) : undefined) ?? prior.declaredOutputPaths;
    nodeOutputs.set(nodeId, {
      state: 'completed',
      output: prior.output,
      // The persisted logical value (#2637): downstream whole-value and `.field`
      // consumers observe exactly what fresh execution exposed. Absent for rows
      // persisted before the key existed — those keep the text-parse fallback.
      ...(prior.structuredOutput !== undefined ? { structuredOutput: prior.structuredOutput } : {}),
      ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
      ...(prior.execution !== undefined ? { execution: prior.execution } : {}),
    });
    prepopulatedCount++;
  }
  getLog().info(
    {
      workflowRunId: workflowRun.id,
      priorCompletedCount: priorCompletedNodes.size,
      prepopulatedCount,
      alwaysRunResumedCount: priorCompletedNodes.size - prepopulatedCount,
    },
    'dag.workflow_resume_prepopulated'
  );
  return nodeOutputs;
}

/**
 * Per-node session persistence across workflow re-runs, keyed by the thread that
 * launched the run (see `persistScopeKey`). An empty key would scope every invocation
 * to the same blank scope, so persistence is skipped in that case.
 */
function openPersistScope(
  store: WorkflowDeps['store'],
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun
): PersistScope | undefined {
  const key = persistScopeKey(workflowRun);
  if (!key || !runMayPersistSessions(workflow)) return undefined;
  return openScope(store, workflow.name, key);
}

/**
 * The run's item scope, which `context: same` nodes continue from across runs. A run
 * without an item has none: those nodes then continue only between loop rounds. The key
 * is prefixed so it never equals a thread scope key, which is a bare conversation id.
 */
function openItemScope(
  store: WorkflowDeps['store'],
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun
): PersistScope | undefined {
  if (workflowRun.item_id === null || !runMayContinueItemSessions(workflow.nodes)) return undefined;
  return openScope(store, workflow.name, `item:${workflowRun.item_id}`);
}

/** Read a scope's rows once, at run start (#2667). */
function openScope(store: WorkflowDeps['store'], workflowName: string, key: string): PersistScope {
  const sessionsAtStart = store.listWorkflowNodeSessions({
    workflow_name: workflowName,
    scope_key: key,
  });
  // A persisted node that never dispatches (skipped by `when:`, or after a failure)
  // never awaits this; a failed read must not become an unhandled rejection there.
  // Nodes that await it still see the rejection.
  sessionsAtStart.catch(() => undefined);
  return { key, workflowName, sessionsAtStart };
}

/**
 * True when some node, loop_group bodies included, declares `context: same`, or a
 * composed fan-out could, since its body resolves only when it runs.
 */
function runMayContinueItemSessions(nodes: readonly DagNode[]): boolean {
  return nodes.some(
    node =>
      node.kind === 'compose_fan_out' ||
      isNodeContextSame(node.context) ||
      (isLoopGroupNode(node) && runMayContinueItemSessions(resolvedBodyNodes(node.loop_group)))
  );
}

/** Nodes whose provider session a `context: { resume }` node reads, loop_group bodies included. */
function collectNamedResumeSources(nodes: readonly DagNode[]): Set<string> {
  const sources = new Set<string>();
  const collect = (level: readonly DagNode[]): void => {
    for (const node of level) {
      if (isNodeContextResume(node.context)) sources.add(node.context.resume);
      if (isLoopGroupNode(node)) collect(resolvedBodyNodes(node.loop_group));
    }
  };
  collect(nodes);
  return sources;
}
