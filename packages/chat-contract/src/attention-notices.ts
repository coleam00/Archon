import { z } from 'zod';
import { chatApprovalDecisionSchema, chatAuthoredOutcomeSchema } from './run-events';

const id = z.string().min(1);
const pausedRun = { runId: id, workflowName: id, nodeId: id, pauseId: id.optional() };

/**
 * A run that needs attention, or the close of one a route was told about. `gate` is
 * answered with approve, reject or respond; `attention` with the `answer` run action,
 * or `resume` when it has no `pauseId` (a wait paused before answers existed).
 */
export const chatAttentionNoticeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('gate'),
    ...pausedRun,
    gateType: z.enum(['approval', 'interactive_loop', 'writeback']),
    message: z.string(),
    decisions: z.array(chatApprovalDecisionSchema),
  }),
  z.object({
    type: z.literal('attention'),
    ...pausedRun,
    message: z.string(),
    form: z.enum(['message', 'approval', 'select', 'multi_select']),
    options: z.array(chatApprovalDecisionSchema),
  }),
  z.object({
    type: z.literal('terminal'),
    runId: id,
    workflowName: id,
    status: z.enum(['completed', 'failed', 'cancelled']),
    authoredOutcome: chatAuthoredOutcomeSchema.optional(),
    totalCostUsd: z.number().nonnegative().optional(),
  }),
]);
export type ChatAttentionNotice = z.infer<typeof chatAttentionNoticeSchema>;

/**
 * `destination` is the configured route's opaque value, passed through unchanged.
 * `conversationId` is set only on a terminal notice: the id this plugin returned for
 * the run's earlier notice on the same route.
 */
export const chatAttentionNoticeRequestSchema = z.object({
  destination: id,
  conversationId: id.optional(),
  notice: chatAttentionNoticeSchema,
});
export type ChatAttentionNoticeRequest = z.infer<typeof chatAttentionNoticeRequestSchema>;

/** A plugin that can thread a follow-up returns the conversation the notice opened. */
export const chatAttentionNoticeResponseSchema = z.object({ conversationId: id.optional() });
export type ChatAttentionNoticeResponse = z.infer<typeof chatAttentionNoticeResponseSchema>;
