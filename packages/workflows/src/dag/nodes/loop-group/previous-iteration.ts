import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { nodeInvocationKey, readNodeRecordEvent } from '../../../node-record-reader';
import { definedOutputPaths, type NodeOutput } from '../../../schemas';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from '../../../store';
import type { WorkflowEventRow } from '../../../schemas/workflow-event';
import type { LoopGroupRun } from './loop-group-state';

type PreviousIterationRun = Pick<LoopGroupRun, 'node' | 'bodyNodes' | 'bodyStepNamePrefix'> & {
  ctx: Pick<LoopGroupRun['ctx'], 'workflowRun' | 'loopGroupPath'> & {
    deps: { store: Pick<IWorkflowStore, 'listEventsForRuns'> };
  };
  resume: Pick<LoopGroupRun['resume'], 'resumeIteration'>;
};

export async function restorePreviousIteration(
  run: PreviousIterationRun
): Promise<Map<string, NodeOutput>> {
  const outputs = new Map<string, NodeOutput>();
  const iteration = run.resume.resumeIteration - 1;
  if (iteration === 0) return outputs;
  const runId = run.ctx.workflowRun.id;
  const events = await run.ctx.deps.store.listEventsForRuns([runId], NODE_STATE_EVENT_TYPES);
  const latest = selectPreviousIterationRows(run, iteration, events.get(runId) ?? []);
  // Select before folding: only this invocation's final evidence may read spill files.
  const snapshot = await foldDagResumeSnapshot([...latest.values()], runId);
  for (const body of run.bodyNodes) {
    const path = run.bodyStepNamePrefix + body.id;
    const row = latest.get(path);
    if (row?.event_type === 'node_skipped') continue;
    if (row?.event_type !== 'node_completed')
      throw restorationError(run, iteration, body.id, 'completed history unavailable');
    const prior = snapshot.completedNodeOutputs.get(path);
    if (!prior || prior.outputTruncation)
      throw restorationError(run, iteration, body.id, 'full historical output unavailable');
    const declaredOutputPaths = definedOutputPaths(body) ?? prior.declaredOutputPaths;
    outputs.set(body.id, {
      ...prior,
      state: 'completed',
      ...(declaredOutputPaths !== undefined ? { declaredOutputPaths } : {}),
    });
  }
  return outputs;
}

function restorationError(
  run: PreviousIterationRun,
  iteration: number,
  bodyId: string,
  reason: string
): Error {
  return new Error(
    `Loop group '${run.node.id}' cannot restore iteration ${String(iteration)} node '${bodyId}': ${reason}`
  );
}

function selectPreviousIterationRows(
  run: PreviousIterationRun,
  iteration: number,
  rows: readonly WorkflowEventRow[]
): Map<string, WorkflowEventRow> {
  const { ctx, node, bodyStepNamePrefix } = run;
  const lineage = [...ctx.loopGroupPath, { groupId: node.id, iteration }];
  const bodyPaths = new Set(run.bodyNodes.map(body => bodyStepNamePrefix + body.id));
  const latest = new Map<string, WorkflowEventRow>();
  // Once the target's latest row is found, older opaque records cannot supersede it.
  for (const row of [...rows].reverse()) {
    if (!row.step_name || !bodyPaths.has(row.step_name)) continue;
    if (latest.has(row.step_name)) continue;
    if (
      row.event_type === 'node_skipped_prior_success' ||
      row.event_type === 'node_always_run_reset' ||
      row.event_type === 'node_prior_cache_invalidated'
    )
      continue;
    let record;
    try {
      record = readNodeRecordEvent(row);
    } catch (cause) {
      throw new Error(
        restorationError(run, iteration, row.step_name, 'invalid historical execution record')
          .message,
        { cause }
      );
    }
    if (!record?.metadata)
      throw restorationError(
        run,
        iteration,
        row.step_name,
        'historical invocation lineage unavailable'
      );
    if (
      nodeInvocationKey(record.path, record.metadata.invocation.loopPath) ===
      nodeInvocationKey(record.path, lineage)
    ) {
      latest.set(record.path, row);
    }
  }
  return latest;
}
