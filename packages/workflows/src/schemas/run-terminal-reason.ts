import { z } from '@hono/zod-openapi';

/**
 * Why a failed run ended. Recorded by the caller that knows (in the terminal
 * event's `exit_reason`), not reconstructed from error text afterwards.
 */
export const runExitReasonSchema = z.enum([
  // No node completed and none failed (for example, every node was skipped).
  'no_nodes_completed',
  // At least one node failed.
  'node_error',
  // The executor caught an error outside any node.
  'unhandled_error',
  // All nodes succeeded but `evidence_policy.required` found no evidence marker (#2230).
  'evidence_missing',
  // The run's recorded executable source could not be reached.
  'source_unavailable',
  // The executor exited while the run was still running (finally-block backstop).
  'not_finalized',
  // The CLI process owning the run was terminated by a signal.
  'process_terminated',
  // A detached launch failed before its worker took the run.
  'launch_failed',
  // No run row could be written, so the run never existed.
  'run_not_created',
]);
export type RunExitReason = z.infer<typeof runExitReasonSchema>;

/** Why a run was cancelled, recorded by the canceller in the terminal event's `cancel_reason`. */
export const runCancelReasonSchema = z.enum([
  // A human rejected an approval gate that cancels the run.
  'approval_rejected',
  // An operator cancelled the run (CLI, web, chat command, API).
  'operator',
  // The workflow's own `cancel:` node ended the run.
  'halt_node',
  // A start-time precondition failed after the run row existed (path in use, setup error).
  'precondition_failed',
  // The conversation's resumable runs were cancelled with it.
  'conversation_reset',
  // A fan-out parent cancelled this child.
  'fan_out',
]);
export type RunCancelReason = z.infer<typeof runCancelReasonSchema>;

/** The POSIX signals an owning CLI process settles its run on. */
export const runStopSignalSchema = z.enum(['SIGINT', 'SIGTERM']);
export type RunStopSignal = z.infer<typeof runStopSignalSchema>;

/**
 * Why a run stopped, recorded on the run row so an operator surface can say it
 * without reading the terminal event. `reason` is the same category the terminal
 * event persists as `exit_reason`; `signal` is present only when a signal arriving
 * at the owning process is what stopped the run.
 *
 * Non-strict on purpose: a record written by a newer binary that carries a field
 * this one does not know must still read as a stop reason, not as corruption.
 */
export const runStopReasonSchema = z.object({
  reason: runExitReasonSchema,
  signal: runStopSignalSchema.optional(),
});
export type RunStopReason = z.infer<typeof runStopReasonSchema>;
