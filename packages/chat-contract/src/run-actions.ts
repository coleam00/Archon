import { z } from 'zod';

const id = z.string().min(1);
export const chatSenderSchema = z.object({
  platformUserId: id,
  displayName: z.string().optional(),
});
const target = { runId: id, sender: chatSenderSchema };
const response = z.object({
  nodeId: id.optional(),
  pauseId: id.optional(),
  text: z.string().optional(),
});
export const chatRunActionSchema = z.discriminatedUnion('action', [
  z.object({ ...target, action: z.literal('approve'), response: response.optional() }),
  z.object({ ...target, action: z.literal('reject'), response: response.optional() }),
  z.object({
    ...target,
    action: z.literal('respond'),
    response: response.extend({ decision: id }),
  }),
  z.object({ ...target, action: z.literal('cancel') }),
]);
export type ChatRunAction = z.infer<typeof chatRunActionSchema>;

// A presentation projection: database rows and execution paths never cross this wire.
export const runActionResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approved'),
    type: z.enum(['interactive_loop', 'approval_gate']),
    resumed: z.boolean(),
  }),
  z.object({
    kind: z.literal('rejected'),
    cancelled: z.boolean(),
    maxAttemptsReached: z.boolean(),
    writeBack: z.boolean(),
    newMode: z.boolean(),
    resumed: z.boolean(),
  }),
  z.object({ kind: z.literal('cooperative'), cancelled: z.boolean() }),
  z.object({
    kind: z.literal('stopped'),
    pid: z.number().int().positive(),
    cleanupWarnings: z.array(z.string()).optional(),
    cascadeFailures: z.number().int().nonnegative(),
    blockedParentRunId: id.nullable(),
  }),
]);
export type RunActionResult = z.infer<typeof runActionResultSchema>;
export const chatRejectedSchema = z.object({
  status: z.literal('rejected'),
  reason: z.literal('not_allowed'),
});
export const chatRunActionResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), result: runActionResultSchema }),
  chatRejectedSchema,
  z.object({ status: z.literal('forbidden'), message: z.string() }),
  z.object({
    status: z.literal('refused'),
    message: z.string(),
    abandonHint: z.string().optional(),
  }),
]);
export type ChatRunActionResponse = z.infer<typeof chatRunActionResponseSchema>;
