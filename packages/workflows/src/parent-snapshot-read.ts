import type { DagResumeSnapshot, IWorkflowStore } from './store';

/** Parent accounting cannot authorize a child or node outcome when its ledger is unreadable. */
export class ParentSnapshotReadError extends Error {
  constructor(
    readonly workflowRunId: string,
    readonly nodeId: string,
    cause: unknown
  ) {
    super(`Could not read parent usage snapshot for '${nodeId}'`, { cause });
    this.name = 'ParentSnapshotReadError';
  }
}

export async function readParentUsageSnapshot(
  store: Pick<IWorkflowStore, 'getDagResumeSnapshot'>,
  workflowRunId: string,
  nodeId: string
): Promise<DagResumeSnapshot> {
  try {
    return await store.getDagResumeSnapshot(workflowRunId);
  } catch (cause) {
    throw new ParentSnapshotReadError(workflowRunId, nodeId, cause);
  }
}
