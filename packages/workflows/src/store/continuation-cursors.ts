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
import { isApprovalContext, isRunBlockedOnChild } from '../schemas/approval-context';

/** Exact persisted cursor expected by an automatic continuation claim. */
export type WorkflowResumeCursor =
  | { kind: 'wait'; nodeId: string; resumeAt: string; pauseId?: string }
  | { kind: 'quota'; attempt: number; resumeAt: string }
  /** An answered gate or attention wait (`answeredPauseContinuation`). */
  | { kind: 'answered'; nodeId: string; pauseId: string }
  /** A run released after a host-local source read failure (`readSourceRelease`). */
  | ({ kind: 'source' } & Omit<SourceRelease, 'path'>);

declare const runOwnerLeaseBrand: unique symbol;

/**
 * Proof that this process holds the live-owner endpoint of `runId`. Only core's
 * `startRunLiveOwner` mints one, so the type checker refuses an ownerless resume from a
 * caller that never opened the endpoint. `isHeld` turns false once the owner closes.
 */
export interface RunOwnerLease {
  readonly runId: string;
  isHeld(): boolean;
  readonly [runOwnerLeaseBrand]: true;
}

/**
 * What a caller carries after finding that no owner answers for a `running` run: the
 * execution claim it read. It resumes nothing until the caller attaches its live-owner
 * lease (`leasedResumeCursor`).
 */
export interface OwnerlessResumeCheck {
  kind: 'ownerless';
  executionClaim: string | null;
}

/**
 * A `running` run whose caller found that no owner answers for it, pinned to the
 * execution claim the caller read, and carrying the caller's live-owner lease for it.
 * Resume mints a new claim, so of two resumers that read the same run, only the first
 * matches. The lease keeps a second resumer on this host out until the first one's owner
 * is visible. It is not a continuation: nothing defers or schedules it.
 */
export interface OwnerlessResumeCursor extends OwnerlessResumeCheck {
  lease: RunOwnerLease;
}

/**
 * A paused parent continued by itself because its blocking child, or every child it waits
 * on (`childRunId` absent), released it (`continueBlockedRun`). Never persisted.
 */
export interface ChildResumeCursor {
  kind: 'child';
  childRunId?: string;
}

/** Every cursor `IWorkflowStore.resumeWorkflowRun` accepts. */
export type ResumeClaimCursor = WorkflowResumeCursor | OwnerlessResumeCursor | ChildResumeCursor;

/** A cursor a caller carries to a resume before it holds the run's live-owner lease. */
export type ResumeRequestCursor = WorkflowResumeCursor | OwnerlessResumeCheck;

/** Attach `lease` to an ownerless check; every other cursor passes through unchanged. */
export function leasedResumeCursor(
  cursor: ResumeRequestCursor | undefined,
  lease: RunOwnerLease
): ResumeClaimCursor | undefined {
  return cursor?.kind === 'ownerless' ? { ...cursor, lease } : cursor;
}

/**
 * Refuse an ownerless resume of run `id` unless its lease is for `id` and still held.
 * Every store calls this before its claim swap. The type requires a lease, but a cast
 * can drop one, and a caller can close its lease before using the cursor. This is a
 * programming error, not a lost race, so it is not `WorkflowNotResumableError`.
 */
export function requireOwnerlessLease(id: string, cursor: ResumeClaimCursor | undefined): void {
  if (cursor?.kind !== 'ownerless') return;
  const lease: RunOwnerLease | undefined = cursor.lease;
  if (lease?.runId !== id || !lease.isHeld()) {
    throw new Error(
      `Ownerless resume of workflow run ${id} needs this process's held live-owner lease for that run`
    );
  }
}

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
    case 'child': {
      if (cursor.childRunId !== undefined) return isRunBlockedOnChild(run, cursor.childRunId);
      const gate = run.metadata.approval;
      return (
        run.status === 'paused' &&
        isApprovalContext(gate) &&
        (gate.type === 'child_workflow' || gate.type === 'fan_out')
      );
    }
  }
}

/** The cursor that resumes `run` while it is still `running` under the claim read here. */
export function ownerlessResumeCursor(
  run: Pick<WorkflowRun, 'metadata'>,
  lease: RunOwnerLease
): OwnerlessResumeCursor {
  return { kind: 'ownerless', executionClaim: executionClaim(run.metadata), lease };
}

/**
 * The cursor an operator's resume carries for a run `resumeWorkflow` just returned. A
 * `running` run passed that check only because no owner answered, so its resume is pinned
 * to the claim that was checked, and resumes once the caller attaches its live-owner lease
 * (`leasedResumeCursor`); any other run needs none. Never derive it from a run that
 * did not pass that check: the store would then resume a run whose owner may be alive.
 */
export function checkedResumeCursor(
  run: Pick<WorkflowRun, 'status' | 'metadata'>
): OwnerlessResumeCheck | undefined {
  return run.status === 'running'
    ? { kind: 'ownerless', executionClaim: executionClaim(run.metadata) }
    : undefined;
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
