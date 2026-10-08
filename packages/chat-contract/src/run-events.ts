import { z } from 'zod';

const id = z.string().min(1);
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
  }),
  z.object({
    type: z.literal('approval_pending'),
    runId: id,
    nodeId: id,
    message: z.string(),
    decisions: z.array(chatApprovalDecisionSchema).optional(),
    pauseId: id.optional(),
  }),
  z.object({
    type: z.literal('terminal'),
    runId: id,
    status: z.enum(['completed', 'failed', 'cancelled']),
    error: z.string().optional(),
    authoredOutcome: z.enum(['succeeded', 'failed', 'unavailable']).optional(),
    totalCostUsd: z.number().nonnegative().optional(),
  }),
]);
export type ChatRunEvent = z.infer<typeof chatRunEventSchema>;
