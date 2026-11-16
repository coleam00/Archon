import {
  answeredPauseContinuation,
  continuablePause,
  isContainerRun,
  isScheduledWorkflowResume,
  pendingWorkflowWaitDeadline,
  readSourceRelease,
  type SourceRelease,
  type WorkflowRun,
} from '../schemas/workflow-run';
import { executionClaim } from './run-writes';

/** Exact persisted cursor expected by an automatic continuation claim. */
export type WorkflowResumeCursor =
  | { kind: 'wait'; nodeId: string; resumeAt: string; pauseId?: string }
  | { kind: 'quota'; attempt: number; resumeAt: string }
  /** An answered gate or attention wait (`answeredPauseContinuation`). */
  | { kind: 'answered'; nodeId: string; pauseId: string }
  /** A run released after a host-local source read failure (`readSourceRelease`). */
  | ({ kind: 'source' } & Omit<SourceRelease, 'path'>);

/**
 * A `running` run whose caller found that no owner answers for it, pinned to the
 * execution claim the caller read (`ownerlessResumeCursor`). Resume mints a new claim, so
 * of two resumers that read the same run, only the first matches. It is not a
 * continuation: nothing defers or schedules it.
 */
export interface OwnerlessResumeCursor {
  kind: 'ownerless';
  executionClaim: string | null;
}

/** Every cursor `IWorkflowStore.resumeWorkflowRun` accepts. */
export type ResumeClaimCursor = WorkflowResumeCursor | OwnerlessResumeCursor;

/** How long an unaccepted continuation, or a run released for unreadable source, waits before the next claim. */
export const CONTINUATION_RETRY_MS = 60_000;

/**
 * True when `run` is still at the exact occurrence `cursor` names. Every store's resume
 * claim and continuation deferral judge this one way, so a host that read an older wait,
 * schedule or answer changes nothing.
 */
export function resumeCursorMatches(
  run: Pick<WorkflowRun, 'status' | 'metadata'>,
  cursor: ResumeClaimCursor
): boolean {
  switch (cursor.kind) {
    case 'wait': {
      const wait = pendingWorkflowWaitDeadline(run);
      return (
        wait?.nodeId === cursor.nodeId &&
        wait.resumeAt === cursor.resumeAt &&
        wait.pauseId === cursor.pauseId
      );
    }
    case 'quota': {
      const scheduled = run.metadata.scheduled_resume;
      return (
        run.status === 'failed' &&
        isScheduledWorkflowResume(scheduled) &&
        scheduled.triggeredAt === undefined &&
        scheduled.attempt === cursor.attempt &&
        scheduled.resumeAt === cursor.resumeAt
      );
    }
    case 'answered': {
      const answered = answeredPauseContinuation(run);
      return answered?.nodeId === cursor.nodeId && answered.pauseId === cursor.pauseId;
    }
    case 'source': {
      const release = readSourceRelease(run.metadata);
      return (
        run.status === 'paused' &&
        release?.nodeId === cursor.nodeId &&
        release.releasedAt === cursor.releasedAt &&
        release.releaseId === cursor.releaseId
      );
    }
    case 'ownerless':
      return run.status === 'running' && executionClaim(run.metadata) === cursor.executionClaim;
  }
}

/** The cursor that resumes `run` while it is still `running` under the claim read here. */
export function ownerlessResumeCursor(run: Pick<WorkflowRun, 'metadata'>): OwnerlessResumeCursor {
  return { kind: 'ownerless', executionClaim: executionClaim(run.metadata) };
}

/**
 * The cursor an operator's resume carries for a run `resumeWorkflow` just returned. A
 * `running` run passed that check only because no owner answered, so its resume is pinned
 * to the claim that was checked; any other run needs none. Never derive it from a run that
 * did not pass that check: the store would then resume a run whose owner may be alive.
 */
export function checkedResumeCursor(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): OwnerlessResumeCursor | undefined {
  return run.status === 'running' ? ownerlessResumeCursor(run) : undefined;
}

export function deadlineWaitCursor(
  wait: NonNullable<ReturnType<typeof pendingWorkflowWaitDeadline>>
): Extract<WorkflowResumeCursor, { kind: 'wait' }> {
  return {
    kind: 'wait',
    nodeId: wait.nodeId,
    resumeAt: wait.resumeAt,
    ...(wait.pauseId !== undefined ? { pauseId: wait.pauseId } : {}),
  };
}

/** A pause the engine continues by itself, named exactly (`continuablePauseCursor`). */
export type PauseCursor =
  | Extract<WorkflowResumeCursor, { kind: 'wait' }>
  | { kind: 'pause'; nodeId: string; pauseId: string };

/**
 * The pause a paused run sits at, if the continuation host continues it by itself: a time
 * or event wait on its deadline, or a gate or attention wait, answered or not
 * (`continuablePause`). Only such a pause gives back the run's resource slot. A parent
 * blocked on a child workflow, a fan-out or a write-back keeps its slot: nothing retries
 * it if its continuation is refused for capacity. A run released for an unreadable source
 * keeps its slot too: it is due again within a minute and re-enters without competing for
 * capacity. Container runs are excluded because the host refuses to continue them.
 */
export function continuablePauseCursor(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): PauseCursor | undefined {
  if (isContainerRun(run)) return undefined;
  const wait = pendingWorkflowWaitDeadline(run);
  if (wait) return deadlineWaitCursor(wait);
  const pause = continuablePause(run);
  return pause && { kind: 'pause', nodeId: pause.nodeId, pauseId: pause.pauseId };
}

/** True when `run` is still paused at exactly the pause `cursor` names. */
export function pauseCursorMatches(
  run: Pick<WorkflowRun, 'status' | 'metadata'>,
  cursor: PauseCursor
): boolean {
  const current = continuablePauseCursor(run);
  if (current?.kind !== cursor.kind || current.nodeId !== cursor.nodeId) return false;
  return current.kind === 'wait'
    ? cursor.kind === 'wait' &&
        current.resumeAt === cursor.resumeAt &&
        current.pauseId === cursor.pauseId
    : cursor.kind === 'pause' && current.pauseId === cursor.pauseId;
}
