import { basename } from 'node:path';
import { getLog } from '../../log';
import { getStaleCachedDependencies } from '../../stale-dependencies';
import { planGraph } from '../../../graph-plan';
import { foldDagResumeSnapshot, type DagResumeEvent } from '../../../dag-resume-snapshot';
import { nodeInvocationKey, readNodeRecordEvent } from '../../../node-record-reader';
import {
  definedOutputPaths,
  isNodeContextResume,
  type NodeOutput,
  type SessionCursor,
} from '../../../schemas';
import type { PersistedNodeOutput } from '../../../store';
import type { LoopGroupRun } from './loop-group-state';

export interface InterruptedIteration {
  iteration: number;
  completed: Map<string, PersistedNodeOutput>;
  previous: Map<string, NodeOutput>;
  sessions: Map<string, SessionCursor>;
  previousSequentialSession?: SessionCursor;
}

/** Rebuild only this invocation's interrupted iteration, never a prior outer-loop visit. */
export async function restoreInterruptedIteration(
  run: LoopGroupRun
): Promise<InterruptedIteration | undefined> {
  const { ctx, resume, node } = run;
  // Answered loop gates start a new iteration; their outputs are history, not cache.
  if (ctx.priorCompletedNodes === undefined || resume.isLoopResume || node.always_run)
    return undefined;
  const staleDeps = getStaleCachedDependencies(
    node,
    ctx.nodeOutputs,
    ctx.priorCompletedNodes,
    ctx.replayedFailures
  );
  if (staleDeps.length > 0) {
    getLog().info(
      { nodeId: node.id, invalidatingDeps: staleDeps },
      'dag.loop_group_prior_cache_invalidated'
    );
    return undefined;
  }
  const hasBodyInvocation = [
    ...ctx.priorCompletedNodes.values(),
    ...(ctx.unfinishedInvocations?.values() ?? []),
  ].some(prior => {
    const execution = 'path' in prior ? prior : prior.execution;
    return execution?.path === run.stepName || execution?.path.startsWith(run.bodyStepNamePrefix);
  });
  // Legacy outputs do not identify an iteration and cannot safely be replayed.
  if (!hasBodyInvocation) return undefined;
  const rows = await ctx.deps.store.listWorkflowEvents(ctx.workflowRun.id);
  const byIteration = new Map<number, DagResumeEvent[]>();
  const mutableSpillIterations = new Set<number>();
  const pathIterations = new Map<string, number>();
  const sessions = new Map<string, SessionCursor>();
  const layers = planGraph(run.bodyNodes).layers;
  const completedSessions = new Map<number, Map<string, SessionCursor | undefined>>();
  const ownerKey = nodeInvocationKey(run.stepName, ctx.loopGroupPath);
  for (const row of rows) {
    if (!row.step_name?.startsWith(run.bodyStepNamePrefix)) continue;
    const record = readNodeRecordEvent(row);
    if (!record) continue;
    if (record.metadata) {
      const path = record.metadata.invocation.loopPath;
      const frame = path[ctx.loopGroupPath.length];
      if (
        frame?.groupId !== node.id ||
        nodeInvocationKey(run.stepName, path.slice(0, ctx.loopGroupPath.length)) !== ownerKey
      ) {
        pathIterations.delete(record.path);
        continue;
      }
      pathIterations.set(record.path, frame.iteration);
    }
    // Cache audit rows have no invocation of their own and inherit the preceding one.
    const iteration = pathIterations.get(record.path);
    if (iteration === undefined) continue;
    const spillPath = record.data.node_output_spill_path;
    if (spillPath && basename(spillPath) === `${record.path}.nodeoutput`)
      mutableSpillIterations.add(iteration);
    if (
      record.eventType === 'node_completed' &&
      record.data.session_id &&
      record.metadata?.binding.provider
    ) {
      sessions.set(record.path, {
        sessionId: record.data.session_id,
        provider: record.metadata.binding.provider,
      });
    }
    if (
      (record.eventType === 'node_completed' && record.data.session_id) ||
      (record.eventType === 'node_skipped_prior_success' && sessions.has(record.path))
    ) {
      const iterationSessions =
        completedSessions.get(iteration) ?? new Map<string, SessionCursor | undefined>();
      iterationSessions.set(
        record.path,
        record.eventType === 'node_completed' && !record.metadata?.binding.provider
          ? undefined
          : sessions.get(record.path)
      );
      completedSessions.set(iteration, iterationSessions);
    }
    const events = byIteration.get(iteration) ?? [];
    events.push(row);
    byIteration.set(iteration, events);
  }
  if (byIteration.size === 0) return undefined;
  const iteration = Math.max(...byIteration.keys());
  // Old writers overwrote this file even when the next lifecycle row never committed.
  // Its bytes cannot attest to a historical iteration, so recompute the body instead.
  if (mutableSpillIterations.has(iteration - 1)) {
    getLog().warn({ nodeId: node.id, iteration }, 'dag.loop_group_mutable_spill_restart');
    return undefined;
  }
  const current = await foldDagResumeSnapshot(byIteration.get(iteration) ?? [], ctx.workflowRun.id);
  const previous = await foldDagResumeSnapshot(
    byIteration.get(iteration - 1) ?? [],
    ctx.workflowRun.id
  );
  const completed = new Map<string, PersistedNodeOutput>();
  const previousOutputs = new Map<string, NodeOutput>();
  for (const body of run.bodyNodes) {
    const path = run.bodyStepNamePrefix + body.id;
    const prior = current.completedNodeOutputs.get(path);
    if (prior) completed.set(body.id, prior);
    const session = sessions.get(path);
    if (session && isNodeContextResume(body.context))
      resume.bodySessionCursors?.set(body.id, session);
    const prev = previous.completedNodeOutputs.get(path);
    if (prev) previousOutputs.set(body.id, restoredBodyOutput(body, prev));
  }
  let previousSequentialSession: SessionCursor | undefined;
  for (const priorIteration of [...byIteration.keys()]
    .filter(i => i < iteration)
    .sort((a, b) => a - b)) {
    if (node.loop_group.fresh_context) previousSequentialSession = undefined;
    const iterationSessions = completedSessions.get(priorIteration);
    for (const layer of layers) {
      if (layer.length > 1) {
        previousSequentialSession = undefined;
      } else {
        for (const body of layer) {
          const path = run.bodyStepNamePrefix + body.id;
          if (iterationSessions?.has(path)) previousSequentialSession = iterationSessions.get(path);
        }
      }
    }
  }
  return {
    iteration,
    completed,
    previous: previousOutputs,
    sessions,
    previousSequentialSession,
  };
}

export function restoredBodyOutput(
  node: LoopGroupRun['bodyNodes'][number],
  prior: PersistedNodeOutput,
  session?: SessionCursor
): NodeOutput {
  return {
    ...prior,
    state: 'completed',
    ...(session ? { sessionId: session.sessionId } : {}),
    declaredOutputPaths: definedOutputPaths(node) ?? prior.declaredOutputPaths,
  };
}
