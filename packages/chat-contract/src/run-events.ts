import { z } from 'zod';

const id = z.string().min(1);
/** The boolean form of a run's outcome. A named outcome travels as `completedOutcome`. */
export const chatAuthoredOutcomeSchema = z.enum(['succeeded', 'failed', 'unavailable']);
/**
 * The outcome a run completed with: `succeeded` or `failed` for a boolean outcome, or the
 * value of a named one such as `built`. Set only on a completed run that declared one.
 */
export const chatCompletedOutcomeSchema = z.string().min(1);
/**
 * Why a failed node failed, as the engine recorded it: the name a `retry.on_error` policy
 * targets, such as `schema_unmet`. For display only. A plain string, so a kind the engine
 * adds later reaches an older plugin instead of failing its parse.
 */
export const chatFailureKindSchema = z.string().min(1);
export const chatApprovalDecisionSchema = z.object({ id, label: z.string().optional() });
export const chatRunEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workflow_started'),
    runId: id,
    conversationId: id,
    workflowName: id,
  }),
  z.object({
    type: z.literal('node_state'),
    runId: id,
    nodeId: id,
    nodeName: id,
    state: z.enum(['running', 'completed', 'failed', 'skipped']),
    durationMs: z.number().nonnegative().optional(),
    error: z.string().optional(),
    failureKind: chatFailureKindSchema.optional(),
  }),
  z.object({
    type: z.literal('approval_pending'),
    runId: id,
    nodeId: id,
    message: z.string(),
    decisions: z.array(chatApprovalDecisionSchema),
    pauseId: id.optional(),
    /** Kept for archon-chat/1; a paused run has no outcome, so the host never sets it. */
    authoredOutcome: chatAuthoredOutcomeSchema.optional(),
  }),
  z.object({
    type: z.literal('terminal'),
    runId: id,
    status: z.enum(['completed', 'failed', 'cancelled']),
    error: z.string().optional(),
    /** On a failed run: the recorded kind of the node the run failed at. */
    failureKind: chatFailureKindSchema.optional(),
    completedOutcome: chatCompletedOutcomeSchema.optional(),
    authoredOutcome: chatAuthoredOutcomeSchema.optional(),
    totalCostUsd: z.number().nonnegative().optional(),
  }),
]);
export type ChatRunEvent = z.infer<typeof chatRunEventSchema>;
