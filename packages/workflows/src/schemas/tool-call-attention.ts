import { z } from 'zod';

export const TOOL_CALL_ATTENTION_METADATA_KEY = 'tool_call_attention';

export const toolCallAttentionSchema = z
  .object({
    streamId: z.string().min(1),
    // Legacy attention remains readable for display, but cannot authorize end-turn.
    stallId: z.string().min(1).optional(),
    nodeId: z.string().min(1),
    provider: z.string().min(1),
    kind: z.literal('provider_turn').optional(),
    toolCallId: z.string().min(1),
    name: z.string().min(1).max(1024),
    title: z.string().max(1024).optional(),
    startedAt: z.iso.datetime(),
    lastProgressAt: z.iso.datetime(),
    raisedAt: z.iso.datetime(),
    thresholdMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const toolCallAttentionArraySchema = z.array(toolCallAttentionSchema);
export type ToolCallAttention = z.infer<typeof toolCallAttentionSchema>;
