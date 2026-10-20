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
  const pathIterations = new Map<string, number>();
  const sessions = new Map<string, SessionCursor>();
  const sequentialPaths = new Set(
    planGraph(run.bodyNodes)
      .layers.filter(layer => layer.length === 1)
      .flatMap(layer => layer.map(body => run.bodyStepNamePrefix + body.id))
  );
  const sequentialSessions = new Map<number, SessionCursor>();
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
    const session = sessions.get(record.path);
    if (
      session &&
      sequentialPaths.has(record.path) &&
      (record.eventType === 'node_completed' || record.eventType === 'node_skipped_prior_success')
    )
      sequentialSessions.set(iteration, session);
    const events = byIteration.get(iteration) ?? [];
    events.push(row);
    byIteration.set(iteration, events);
  }
  if (byIteration.size === 0) return undefined;
  const iteration = Math.max(...byIteration.keys());
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
  return {
    iteration,
    completed,
    previous: previousOutputs,
    sessions,
    previousSequentialSession: sequentialSessions.get(iteration - 1),
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
