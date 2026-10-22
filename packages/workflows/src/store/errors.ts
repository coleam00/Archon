import type { ResourceBlocker } from '../resource-start-store';

/** Only a zero-row pause CAS produces this error; storage failures must propagate. */
export class WorkflowRunPauseConflictError extends Error {
  constructor(runId: string) {
    super(`Workflow run not found or not in running state (id: ${runId})`);
    this.name = 'WorkflowRunPauseConflictError';
  }
}

/**
 * Thrown by resumeWorkflowRun when the target run is no longer in a resumable
 * state (already running/terminal, or concurrently resumed). Callers translate
 * this into a user-facing "already being resumed" message instead of leaking
 * the raw internal error string.
 */
export class WorkflowNotResumableError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentStatus: string
  ) {
    super(
      `Workflow run is not resumable (id: ${runId}, status: ${currentStatus}). ` +
        'It may have already been resumed, completed, or cancelled.'
    );
    this.name = 'WorkflowNotResumableError';
  }
}

/**
 * What a refused resume leaves behind: a failed run stays failed; a paused run stays
 * paused, and `waiting` means it also keeps its place as a capacity waiter.
 */
export type ResumeRefusal = 'failed' | 'paused' | 'waiting';

export class WorkflowResourceBusyError extends Error {
  constructor(
    public readonly runId: string,
    public readonly blocker: ResourceBlocker,
    public readonly refusal: ResumeRefusal = 'failed'
  ) {
    const reason = `Workflow run '${runId}' cannot resume while ${blocker.kind === 'run' ? 'resource owner' : 'queued request'} '${blocker.id}' has priority.`;
    super(
      refusal === 'waiting'
        ? `${reason} It stays paused and keeps its place; a continuation host continues it once capacity frees.`
        : refusal === 'paused'
          ? `${reason} It stays paused; a continuation host continues it once its wait ends and capacity frees.`
          : reason
    );
    this.name = 'WorkflowResourceBusyError';
  }
}
