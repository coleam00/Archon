/**
 * Run and step lifecycle statuses, and the terminal-status vocabulary derived from them.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// WorkflowRunStatus
// ---------------------------------------------------------------------------

/**
 * `'paused'` is treated as a still-live status for in-flight sibling node streaming:
 * a concurrent gate pausing the run must not tear down an unrelated node's
 * already-streaming output in the same topological layer. See
 * `shouldContinueStreamingForStatus` in dag/run-control.ts, which encodes this policy.
 */
export const workflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'paused',
]);

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

// ---------------------------------------------------------------------------
// WorkflowRunOutcome
// ---------------------------------------------------------------------------

/**
 * Workflow-authored verdict, independent from engine-owned lifecycle status.
 * Null on a run means no declared result has been authored yet (or the
 * workflow does not declare one); it never means failure.
 */
export const workflowRunOutcomeSchema = z.enum(['succeeded', 'failed']);

export type WorkflowRunOutcome = z.infer<typeof workflowRunOutcomeSchema>;

/**
 * The narrow tuple behind `TERMINAL_WORKFLOW_STATUSES`. It exists only so
 * `RunTerminalStatus` can be derived from the same list the runtime checks
 * against — the exported constant keeps its widened element type because
 * callers pass an arbitrary `WorkflowRunStatus` to `.includes()`.
 */
const TERMINAL_STATUS_TUPLE = ['completed', 'failed', 'cancelled'] as const;
export const terminalWorkflowRunStatusSchema =
  workflowRunStatusSchema.extract(TERMINAL_STATUS_TUPLE);

/** Statuses that indicate a run has finished and cannot transition further. */
export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = TERMINAL_STATUS_TUPLE;

/** A finished run's status — the narrow half of `TERMINAL_WORKFLOW_STATUSES`. */
export type RunTerminalStatus = (typeof TERMINAL_STATUS_TUPLE)[number];

/** Persisted terminal event names; every terminal status must have one. */
export const TERMINAL_RUN_EVENT_TYPE = {
  completed: 'workflow_completed',
  failed: 'workflow_failed',
  cancelled: 'workflow_cancelled',
} as const satisfies { [Status in RunTerminalStatus]: `workflow_${Status}` };

export const TERMINAL_RUN_EVENT_TYPES: readonly (typeof TERMINAL_RUN_EVENT_TYPE)[RunTerminalStatus][] =
  Object.values(TERMINAL_RUN_EVENT_TYPE);

export function terminalRunStatusForEventType(eventType: string): RunTerminalStatus | undefined {
  return TERMINAL_STATUS_TUPLE.find(status => TERMINAL_RUN_EVENT_TYPE[status] === eventType);
}

/** Narrowing membership test for `TERMINAL_WORKFLOW_STATUSES`. */
export function isTerminalRunStatus(status: WorkflowRunStatus): status is RunTerminalStatus {
  return TERMINAL_STATUS_TUPLE.some(terminal => terminal === status);
}

/** Cancellation leaves these statuses untouched; failed runs remain cancellable because they can resume. */
export const CANCELLATION_NOOP_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] =
  workflowRunStatusSchema.extract(['completed', 'cancelled']).options;

/** Statuses that allow a user to resume execution. */
export const RESUMABLE_WORKFLOW_STATUSES: readonly WorkflowRunStatus[] = [
  'failed',
  'paused',
] as const;

// ---------------------------------------------------------------------------
// WorkflowStepStatus
// ---------------------------------------------------------------------------

export const workflowStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>;
