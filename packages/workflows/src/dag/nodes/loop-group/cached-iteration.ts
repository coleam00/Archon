import { foldDagResumeSnapshot, type DagResumeEvent } from '../../../dag-resume-snapshot';
import { nodeInvocationKey, readNodeRecordEvent } from '../../../node-record-reader';
import { definedOutputPaths, type NodeOutput } from '../../../schemas';
import { NODE_STATE_EVENT_TYPES, type PersistedNodeOutput } from '../../../store';
import type { WorkflowEventRow } from '../../../schemas/workflow-event';
import type { LoopGroupRun } from './loop-group-state';

export interface CachedLoopIteration {
  iteration: number;
  completedNodes: Map<string, PersistedNodeOutput>;
  previousOutputs: Map<string, NodeOutput>;
}

/** Recover only the iteration being resumed; loop-owned pauses start a fresh iteration. */
export async function readCachedLoopIteration(
  run: LoopGroupRun
): Promise<CachedLoopIteration | undefined> {
  const { ctx, resume } = run;
  if (
    ctx.priorCompletedNodes === undefined ||
    resume.isLoopResume ||
    ctx.priorCompletedNodes.has(run.node.id)
  )
    return undefined;
  const iterationOf = bodyIterationResolver(run);
  const iterations = [
    ...[...ctx.nodeOutputs].flatMap(([path, output]) =>
      output.execution ? [iterationOf(path, output.execution.invocation.loopPath)] : []
    ),
    ...[...(ctx.unfinishedInvocations?.values() ?? [])].map(record =>
      iterationOf(record.path, record.invocation.loopPath)
    ),
  ].filter((iteration): iteration is number => iteration !== undefined);
  if (iterations.length === 0) return undefined;
  const rows =
    (await ctx.deps.store.listEventsForRuns([ctx.workflowRun.id], NODE_STATE_EVENT_TYPES)).get(
      ctx.workflowRun.id
    ) ?? [];
  const byIteration = groupIterationRows(rows, iterationOf);
  if (byIteration.size === 0) return undefined;
  const iteration = Math.max(...byIteration.keys());
  const current = await foldDagResumeSnapshot(byIteration.get(iteration) ?? [], ctx.workflowRun.id);
  const previous = await foldDagResumeSnapshot(
    byIteration.get(iteration - 1) ?? [],
    ctx.workflowRun.id
  );
  const localCompletions = (completed: Map<string, PersistedNodeOutput>) =>
    new Map(
      [...completed].map(([path, output]) => [path.slice(run.bodyStepNamePrefix.length), output])
    );
  return {
    iteration,
    completedNodes: localCompletions(current.completedNodeOutputs),
    previousOutputs: cachedBodyOutputs(run, localCompletions(previous.completedNodeOutputs)),
  };
}

export function cachedBodyOutputs(
  run: LoopGroupRun,
  completed: ReadonlyMap<string, PersistedNodeOutput>
): Map<string, NodeOutput> {
  const outputs = new Map<string, NodeOutput>();
  for (const node of run.bodyNodes) {
    const prior = completed.get(node.id);
    if (!prior) continue;
    outputs.set(node.id, {
      ...prior,
      state: 'completed',
      declaredOutputPaths: definedOutputPaths(node) ?? prior.declaredOutputPaths,
    });
  }
  return outputs;
}

function bodyIterationResolver(run: LoopGroupRun) {
  const { ctx } = run;
  const ownerKey = nodeInvocationKey(run.stepName, ctx.loopGroupPath);
  return (path: string, loopPath: typeof ctx.loopGroupPath): number | undefined => {
    if (
      !path.startsWith(run.bodyStepNamePrefix) ||
      !run.directBodyIds.has(path.slice(run.bodyStepNamePrefix.length))
    )
      return undefined;
    const frame = loopPath.at(-1);
    return frame?.groupId === run.node.id &&
      nodeInvocationKey(run.stepName, loopPath.slice(0, -1)) === ownerKey
      ? frame.iteration
      : undefined;
  };
}

function groupIterationRows(
  rows: readonly WorkflowEventRow[],
  iterationOf: ReturnType<typeof bodyIterationResolver>
): Map<number, DagResumeEvent[]> {
  const byIteration = new Map<number, DagResumeEvent[]>();
  const pathIterations = new Map<string, number | undefined>();
  for (const row of rows) {
    const record = readNodeRecordEvent(row);
    if (!record) continue;
    if (record.metadata) {
      pathIterations.set(
        record.path,
        iterationOf(record.path, record.metadata.invocation.loopPath)
      );
    }
    // Cache audit rows have no invocation of their own; they belong to the preceding
    // execution of that path, including on a second resume of the same iteration.
    const rowIteration = pathIterations.get(record.path);
    if (rowIteration === undefined) continue;
    const bucket = byIteration.get(rowIteration) ?? [];
    bucket.push(row);
    byIteration.set(rowIteration, bucket);
  }
  return byIteration;
}
