import { z } from 'zod';

export const nodeStateSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

export type NodeState = z.infer<typeof nodeStateSchema>;

export const skipCauseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('condition'), expr: z.string() }),
  z.object({ kind: z.literal('condition_parse_error'), expr: z.string() }),
  z.object({ kind: z.literal('timeout') }),
  z.object({ kind: z.literal('upstream_failed'), origin: z.string() }),
  z.object({ kind: z.literal('upstream_skipped'), origin: z.string() }),
]);

export type SkipCause = z.infer<typeof skipCauseSchema>;

export const nodeSkipReasonSchema = z.enum([
  'prior_success',
  'when_condition',
  'when_condition_parse_error',
  'trigger_rule',
  'timeout',
]);

export type NodeSkipReason = z.infer<typeof nodeSkipReasonSchema>;

/**
 * The suspend reason vocabulary (#2489) — a Zod-backed enum, not a renamed union: the
 * values are persisted verbatim into `workflow_runs.metadata.approval.type`, so they
 * cannot change without breaking reads of already-paused runs. Every pause site now
 * writes through one shared helper (`pauseGateRespectingExternalTransition` in
 * dag/pause.ts), but each reason's RESUME path stays deliberately separate and
 * lives at its own named site:
 *  - `'approval'` / `'interactive_loop'` — resolved externally by a human decision:
 *    `approveWorkflow`/`rejectWorkflow` (operations/workflow-operations.ts).
 *  - `'writeback'` — also resolved by `approveWorkflow`/`rejectWorkflow`'s write-back
 *    branch, then applied on parent resume by `runContainerWriteBackGate`
 *    (dag/container-gate.ts, `raiseWriteBackGate`'s sibling).
 *  - `'child_workflow'` — never resolved by the approve/reject endpoints directly
 *    (redirected instead — `assertApprovable`/`assertRejectable`); re-inspected by
 *    `executeWorkflowNode` re-running on parent resume (dag/nodes/workflow).
 *  - `'fan_out'` — a `fan_out:` workflow node waiting on its non-terminal children.
 *    Resolved only by those children reaching terminal states, never by approve/reject
 *    (redirected like `'child_workflow'`); re-inspected by `executeFanOutWorkflowNode`
 *    on parent re-entry (dag/nodes/workflow).
 */
export const suspendReasonSchema = z.enum([
  'approval',
  'interactive_loop',
  'writeback',
  'child_workflow',
  'fan_out',
]);
export type SuspendReason = z.infer<typeof suspendReasonSchema>;
