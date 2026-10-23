import type { WorkflowRunStatus } from './schemas/workflow-run';

export const STALE_PENDING_AGE_MS = 5 * 60 * 1000;
export const WORKFLOW_PATH_LOCK_STATUSES = [
  'running',
  'paused',
] as const satisfies readonly WorkflowRunStatus[];

/** Pending pre-creates stop holding a path after the executor's dispatch window. */
export function holdsWorkflowPath(
  run: { status: WorkflowRunStatus; started_at: Date },
  now = Date.now()
): boolean {
  return (
    WORKFLOW_PATH_LOCK_STATUSES.some(status => status === run.status) ||
    (run.status === 'pending' && run.started_at.getTime() > now - STALE_PENDING_AGE_MS)
  );
}
