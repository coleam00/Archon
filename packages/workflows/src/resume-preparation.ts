import { isDeepStrictEqual } from 'node:util';
import type { WorkflowRun } from './schemas/workflow-run';
import { executionClaim } from './store';

type ResumeLifecycle = Pick<
  WorkflowRun,
  'status' | 'started_at' | 'completed_at' | 'last_activity_at'
>;

export interface ResumePreparationUndo {
  claim: string;
  lifecycle: ResumeLifecycle;
  metadata: Record<string, { value: unknown } | { absent: true }>;
}

/** Capture the inverse of the actual transition, including keys removed by admission. */
export function resumePreparationUndo(
  before: WorkflowRun,
  admitted: WorkflowRun
): ResumePreparationUndo {
  const claim = executionClaim(admitted.metadata);
  if (claim === null) throw new Error(`Resume admission has no execution claim: ${admitted.id}`);
  const metadata: ResumePreparationUndo['metadata'] = {};
  for (const key of new Set([...Object.keys(before.metadata), ...Object.keys(admitted.metadata)])) {
    if (
      Object.hasOwn(before.metadata, key) === Object.hasOwn(admitted.metadata, key) &&
      isDeepStrictEqual(before.metadata[key], admitted.metadata[key])
    )
      continue;
    metadata[key] = Object.hasOwn(before.metadata, key)
      ? { value: structuredClone(before.metadata[key]) }
      : { absent: true };
  }
  return {
    claim,
    lifecycle: {
      status: before.status,
      started_at: before.started_at,
      completed_at: before.completed_at,
      last_activity_at: before.last_activity_at,
    },
    metadata,
  };
}

export function restoreResumePreparation(
  current: WorkflowRun,
  undo: ResumePreparationUndo
): ResumeLifecycle & { metadata: WorkflowRun['metadata'] } {
  if (current.status !== 'running' || executionClaim(current.metadata) !== undo.claim)
    throw new Error(`Resume preparation lost execution ownership: ${current.id}`);
  const metadata = structuredClone(current.metadata);
  for (const [key, prior] of Object.entries(undo.metadata)) {
    if ('absent' in prior) delete metadata[key];
    else metadata[key] = structuredClone(prior.value);
  }
  return { ...undo.lifecycle, metadata };
}

/** Setup runs once after commit; only the acquired claim authorizes its compensation. */
export async function prepareResumedRun(
  admitted: WorkflowRun,
  prepare: ((run: WorkflowRun) => Promise<void>) | undefined,
  undo: () => Promise<void>
): Promise<WorkflowRun> {
  if (prepare) {
    try {
      await prepare(structuredClone(admitted));
    } catch (error) {
      try {
        await undo();
      } catch (undoError) {
        throw new Error(
          `Resume preparation failed; admission could not be restored: ${String(undoError)}`,
          {
            cause: error,
          }
        );
      }
      throw error;
    }
  }
  return admitted;
}
