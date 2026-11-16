import { foldDagResumeSnapshot } from '../../../dag-resume-snapshot';
import { nodeInvocationKey, readNodeRecordEvent } from '../../../node-record-reader';
import { definedOutputPaths, type NodeOutput } from '../../../schemas';
import { NODE_STATE_EVENT_TYPES, type IWorkflowStore } from '../../../store';
import type { WorkflowEventRow } from '../../../schemas/workflow-event';
import type { NodeExecutionMetadata, NodeInvocation } from '../../../schemas/node-execution';
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

/**
 * The round a failed or interrupted run stopped in: the highest iteration of THIS group
 * invocation that has any body row, and whether every body node finished in it (its
 * latest row there is completed or skipped). Undefined when no body row was written.
 */
export async function findInterruptedIteration(
  run: Omit<PreviousIterationRun, 'resume'>
): Promise<{ iteration: number; finished: boolean } | undefined> {
  const runId = run.ctx.workflowRun.id;
  const events = await run.ctx.deps.store.listEventsForRuns([runId], NODE_STATE_EVENT_TYPES);
  let interrupted: number | undefined;
  let latest = new Map<string, WorkflowEventRow['event_type']>();
  for (const { row, path, iteration } of ownBodyRecords(
    run,
    events.get(runId) ?? [],
    (stepName, reason) =>
      new Error(
        `Loop group '${run.node.id}' cannot find the iteration it stopped in from node '${stepName}': ${reason}`
      )
  )) {
    if (iteration === undefined || iteration < (interrupted ?? 0)) continue;
    if (iteration > (interrupted ?? 0)) latest = new Map();
    interrupted = iteration;
    latest.set(path, row.event_type);
  }
  if (interrupted === undefined) return undefined;
  const finished = run.bodyNodes.every(body => {
    const eventType = latest.get(run.bodyStepNamePrefix + body.id);
    return eventType === 'node_completed' || eventType === 'node_skipped';
  });
  return { iteration: interrupted, finished };
}

function selectPreviousIterationRows(
  run: PreviousIterationRun,
  iteration: number,
  rows: readonly WorkflowEventRow[]
): Map<string, WorkflowEventRow> {
  const latest = new Map<string, WorkflowEventRow>();
  const records = ownBodyRecords(
    run,
    [...rows].reverse(),
    (stepName, reason) => restorationError(run, iteration, stepName, reason),
    // Once the target's latest row is found, older opaque records cannot supersede it.
    stepName => latest.has(stepName)
  );
  for (const record of records) {
    if (record.iteration === iteration) latest.set(record.path, record.row);
  }
  return latest;
}

/**
 * This group's body rows in `rows` order, each with the iteration of THIS group invocation
 * it ran in. The iteration is undefined for a row from another invocation of the group, such
 * as one under another iteration of an enclosing group. Replay markers carry no execution of
 * their own and are skipped; a row without readable lineage fails rather than being guessed.
 */
function* ownBodyRecords(
  run: Omit<PreviousIterationRun, 'resume'>,
  rows: readonly WorkflowEventRow[],
  fail: (stepName: string, reason: string) => Error,
  skip?: (stepName: string) => boolean
): Generator<{ row: WorkflowEventRow; path: string; iteration: number | undefined }> {
  const bodyPaths = new Set(run.bodyNodes.map(body => run.bodyStepNamePrefix + body.id));
  for (const row of rows) {
    const stepName = row.step_name;
    if (!stepName || !bodyPaths.has(stepName) || skip?.(stepName) || isReplayMarker(row)) continue;
    const record = readLineage(row, stepName, fail);
    yield {
      row,
      path: record.path,
      iteration: ownIteration(run, record.metadata.invocation.loopPath),
    };
  }
}

function isReplayMarker(row: WorkflowEventRow): boolean {
  return (
    row.event_type === 'node_skipped_prior_success' ||
    row.event_type === 'node_always_run_reset' ||
    row.event_type === 'node_prior_cache_invalidated'
  );
}

function readLineage(
  row: WorkflowEventRow,
  stepName: string,
  fail: (stepName: string, reason: string) => Error
): { path: string; metadata: NodeExecutionMetadata } {
  let record;
  try {
    record = readNodeRecordEvent(row);
  } catch (cause) {
    throw new Error(fail(stepName, 'invalid historical execution record').message, { cause });
  }
  if (!record?.metadata) throw fail(stepName, 'historical invocation lineage unavailable');
  return { path: record.path, metadata: record.metadata };
}

/** The iteration of THIS group invocation a body row's loop path ran in, if it is one. */
function ownIteration(
  run: Omit<PreviousIterationRun, 'resume'>,
  loopPath: NodeInvocation['loopPath']
): number | undefined {
  const enclosing = run.ctx.loopGroupPath;
  const frame = loopPath[enclosing.length];
  if (loopPath.length !== enclosing.length + 1 || frame?.groupId !== run.node.id) return undefined;
  return nodeInvocationKey('', loopPath.slice(0, -1)) === nodeInvocationKey('', enclosing)
    ? frame.iteration
    : undefined;
}
