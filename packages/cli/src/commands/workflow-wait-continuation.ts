import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { RunLiveOwnerAlreadyOwnedError } from '@archon/core/services/run-live-owner';
import {
  WorkflowNotResumableError,
  deadlineWaitCursor,
  resumeCursorMatches,
} from '@archon/workflows/store';
import {
  pendingWorkflowWaitDeadline,
  workflowWaitStepName,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import {
  destinationCorrelationId,
  resolveDiscoveryCwdForCodebase,
  type RunDestination,
  type WorkflowRunOptions,
} from './workflow-shared';

/**
 * The durable cursor of a wait that this run's own process must wake. `attention`
 * waits are excluded at the source: they are a decision, not a deadline.
 */
export interface DurableWaitCursor {
  stepName: string;
  cursor: ReturnType<typeof deadlineWaitCursor>;
  signaled: boolean;
}

/** A run this process should resume itself once its wait's deadline arrives. */
export interface PendingWaitContinuation {
  run: WorkflowRun;
  wait: DurableWaitCursor;
  /**
   * The platform conversation the first attempt ran under. Threaded into every
   * continuation so the resumed segment's dispatch and result card stay in the run's
   * original thread instead of generating a second conversation. An origin-free run
   * stays headless.
   */
  destination: RunDestination;
}

/**
 * Read the wait this process owns off a run row, if any.
 *
 * `undefined` means the run is not paused on a time, event or usage-limit wait — a terminal
 * run, a gate, or an `attention` wait, none of which has a deadline to enforce.
 */
export function pendingDurableWait(run: WorkflowRun): DurableWaitCursor | undefined {
  const wait = pendingWorkflowWaitDeadline(run);
  if (!wait) return undefined;
  return {
    stepName: workflowWaitStepName(wait),
    cursor: deadlineWaitCursor(wait),
    signaled: wait.kind === 'event' && wait.signaledAt !== undefined,
  };
}

/** How soon a sleeping owner notices that another host moved or released its run. */
const WAIT_CONTINUATION_POLL_MS = 5_000;

/**
 * Sleep until this run's wait is due, then let the caller resume it.
 *
 * The row is re-read every poll rather than trusting the cursor copied at pause
 * time: `archon serve`'s scan, an operator's `resume`/`resignal`/`abandon`, or a
 * crash can move or end the wait. A superseded cursor stops the loop instead of
 * executing a run this process no longer owns; the resume's own compare-and-swap
 * is the final guard.
 */
export async function awaitDurableWaitDeadline(
  host: WorkflowHost,
  runId: string,
  wait: DurableWaitCursor
): Promise<'resume' | 'stop'> {
  if (wait.signaled) return 'resume';
  for (;;) {
    const remainingMs = Date.parse(wait.cursor.resumeAt) - Date.now();
    if (remainingMs <= 0) return 'resume';
    await new Promise<void>(resolve =>
      setTimeout(resolve, Math.min(remainingMs, WAIT_CONTINUATION_POLL_MS))
    );
    const latest = await host.deps.store.getWorkflowRun(runId);
    const next = latest === null ? undefined : pendingDurableWait(latest);
    if (
      !latest ||
      !next ||
      next.stepName !== wait.stepName ||
      !resumeCursorMatches(latest, wait.cursor)
    ) {
      return 'stop';
    }
    if (next.signaled) return 'resume';
  }
}

/** The invocation parameters of one continuation attempt, in `workflowRunCommand`'s shape. */
export interface WaitResumeAttempt {
  cwd: string;
  workflowName: string;
  userMessage: string;
  options: WorkflowRunOptions;
}

/** Mirror `workflowResumeCommand`'s continuation options for a run this process owns. */
export async function buildWaitResumeAttempt(
  host: WorkflowHost,
  run: WorkflowRun,
  destination: RunDestination,
  wait: DurableWaitCursor
): Promise<WaitResumeAttempt> {
  if (!run.working_path) {
    throw new Error(
      `Workflow run '${run.id}' has no working path recorded.\n` +
        'Cannot determine where to resume. The run may be too old.'
    );
  }
  const discoveryCwd = run.codebase_id
    ? await resolveDiscoveryCwdForCodebase(host, run.id, run.codebase_id, 'resume')
    : undefined;
  return {
    cwd: run.working_path,
    workflowName: run.workflow_name,
    userMessage: run.user_message ?? '',
    options: {
      continuationRun: run,
      continuationCursor: wait.cursor,
      resume: true,
      codebaseId: run.codebase_id ?? undefined,
      ...(destination.kind === 'conversation'
        ? { conversationId: destinationCorrelationId(destination) }
        : {}),
      discoveryCwd,
    },
  };
}

/**
 * True when a resume attempt lost the run to another owner rather than failing.
 *
 * Both signals mean another process is executing the run — it won the claim (the
 * compare-and-swap left the row `running`) or still holds its endpoint — so this
 * process should say so and stop instead of reporting a failure. A claim lost to a
 * cancel, failure or completion is not that: nothing continues the run, so it stays
 * an error.
 */
export function isResumeSuperseded(error: unknown): boolean {
  const MAX_CAUSE_DEPTH = 5;
  for (let current: unknown = error, depth = 0; current instanceof Error; depth += 1) {
    if (
      (current instanceof WorkflowNotResumableError && current.currentStatus === 'running') ||
      current instanceof RunLiveOwnerAlreadyOwnedError
    ) {
      return true;
    }
    if (depth >= MAX_CAUSE_DEPTH) return false;
    current = current.cause;
  }
  return false;
}
