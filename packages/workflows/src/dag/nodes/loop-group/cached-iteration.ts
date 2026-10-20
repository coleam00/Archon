import { basename } from 'node:path';
import { foldDagResumeSnapshot, type DagResumeEvent } from '../../../dag-resume-snapshot';
import { nodeInvocationKey, readNodeRecordEvent } from '../../../node-record-reader';
import { definedOutputPaths, type NodeOutput } from '../../../schemas';
import { getStaleCachedDependencies } from '../../stale-dependencies';
import { collectNamedResumeSources } from '../../resume-state';
import { recordNodeState } from '../../../node-event-write';
import { describeExecutionNode } from '../../../node-execution';
import { NODE_STATE_EVENT_TYPES, type PersistedNodeOutput } from '../../../store';
import type { WorkflowEventRow } from '../../../schemas/workflow-event';
import type { LoopGroupRun } from './loop-group-state';

export interface CachedLoopIteration {
  iteration: number;
  completedNodes: Map<string, PersistedNodeOutput>;
  previousOutputs: Map<string, NodeOutput>;
}

/** Failure recovery must not replace the replay owned by a persisted pause. */
export async function readCachedLoopIteration(
  run: LoopGroupRun
): Promise<CachedLoopIteration | undefined> {
  const { ctx, resume } = run;
  if (
    ctx.priorCompletedNodes === undefined ||
    resume.isLoopResume ||
    resume.enclosingPauseIteration !== undefined ||
    ctx.priorCompletedNodes.has(run.node.id)
  )
    return undefined;
  const staleDeps = getStaleCachedDependencies(
    run.node,
    ctx.nodeOutputs,
    ctx.priorCompletedNodes,
    ctx.replayedFailures
  );
  if (staleDeps.length > 0) {
    await recordNodeState(
      { store: ctx.deps.store, logDir: ctx.logDir },
      {
        runId: ctx.workflowRun.id,
        path: run.stepName,
        node: describeExecutionNode(run.node),
        cache: { action: 'invalidated', invalidatingDeps: staleDeps, prior: { text: '' } },
      }
    );
    return undefined;
  }
  const iterationOf = bodyIterationResolver(run);
  const rows =
    (await ctx.deps.store.listEventsForRuns([ctx.workflowRun.id], NODE_STATE_EVENT_TYPES)).get(
      ctx.workflowRun.id
    ) ?? [];
  const byIteration = groupIterationRows(currentExecutionRows(run, rows), iterationOf);
  if (byIteration.size === 0) return undefined;
  const iteration = Math.max(...byIteration.keys());
  const current = await foldDagResumeSnapshot(byIteration.get(iteration) ?? [], ctx.workflowRun.id);
  const previousRows = byIteration.get(iteration - 1) ?? [];
  refuseOverwrittenSpills(previousRows, rows, ctx.workflowRun.id);
  const previous = await foldDagResumeSnapshot(previousRows, ctx.workflowRun.id);
  const localCompletions = (completed: Map<string, PersistedNodeOutput>) =>
    new Map(
      [...completed].map(([path, output]) => [path.slice(run.bodyStepNamePrefix.length), output])
    );
  const previousOutputs = cachedBodyOutputs(run, localCompletions(previous.completedNodeOutputs));
  const finalExecutions = new Map(
    previousRows.flatMap(row => {
      const record = readNodeRecordEvent({
        ...row,
        workflow_run_id: ctx.workflowRun.id,
        data: row.data,
      });
      return record?.metadata ? [[record.path, record.metadata] as const] : [];
    })
  );
  for (const [path, execution] of finalExecutions) {
    if (execution.lifecycle.status !== 'skipped') continue;
    previousOutputs.set(path.slice(run.bodyStepNamePrefix.length), {
      state: 'skipped',
      output: '',
      cause: execution.lifecycle.cause,
      execution,
    });
  }
  const completedNodes = localCompletions(current.completedNodeOutputs);
  // Failure recovery has no iteration-scoped provider handles. Named sources in
  // this body must dispatch again so remaining consumers can fork a live session.
  for (const id of collectNamedResumeSources(run.bodyNodes)) completedNodes.delete(id);
  return {
    iteration,
    completedNodes,
    previousOutputs,
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

function currentExecutionRows(
  run: LoopGroupRun,
  rows: readonly WorkflowEventRow[]
): readonly WorkflowEventRow[] {
  const ownerKey = nodeInvocationKey(run.stepName, run.ctx.loopGroupPath);
  let groupKey: string | undefined;
  let start = 0;
  for (const [index, row] of rows.entries()) {
    const record = readNodeRecordEvent(row);
    if (record?.path !== run.stepName) continue;
    if (record.metadata)
      groupKey = nodeInvocationKey(record.path, record.metadata.invocation.loopPath);
    if (groupKey !== ownerKey) continue;
    if (
      record.eventType === 'node_completed' ||
      record.eventType === 'node_always_run_reset' ||
      record.eventType === 'node_prior_cache_invalidated'
    )
      start = index + 1;
  }
  return rows.slice(start);
}

function spillWriteHistory(rows: readonly WorkflowEventRow[]) {
  const writers = new Map<string, string>();
  const unfinished = new Map<string, string>();
  for (const row of rows) {
    const record = readNodeRecordEvent(row);
    if (record?.metadata) {
      if (record.eventType === 'node_started')
        unfinished.set(record.path, record.metadata.attempt.id);
      else if (
        (record.eventType === 'node_completed' ||
          record.eventType === 'node_failed' ||
          record.eventType === 'node_skipped') &&
        unfinished.get(record.path) === record.metadata.attempt.id
      )
        unfinished.delete(record.path);
    }
    if (record?.metadata && record.data.node_output_spill_path) {
      writers.set(record.data.node_output_spill_path, record.metadata.attempt.id);
    }
  }
  return { writers, unfinished };
}

function refuseOverwrittenSpills(
  previous: readonly DagResumeEvent[],
  rows: readonly WorkflowEventRow[],
  runId: string
): void {
  const { writers, unfinished } = spillWriteHistory(rows);
  const completions = new Map<string, NonNullable<ReturnType<typeof readNodeRecordEvent>>>();
  for (const row of previous) {
    const record = readNodeRecordEvent({ ...row, workflow_run_id: runId, data: row.data });
    if (!record || record.eventType === 'node_skipped_prior_success') continue;
    completions.delete(record.path);
    if (record.eventType === 'node_completed') completions.set(record.path, record);
  }
  for (const record of completions.values()) {
    const spill = record.data.node_output_spill_path;
    // Historical step-keyed spills can be replaced before a completion commits.
    // Exec failures and timeout skips return before writing a spill.
    if (
      spill &&
      record.metadata &&
      (writers.get(spill) !== record.metadata.attempt.id ||
        (basename(spill) === `${record.path}.nodeoutput` && unfinished.has(record.path)))
    ) {
      throw new Error(
        `Cannot resume loop: overwritten output spill for '${record.path}' in the preceding iteration`
      );
    }
  }
}
