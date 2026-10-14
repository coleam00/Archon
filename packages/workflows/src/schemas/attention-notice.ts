import { z } from 'zod';

export const attentionNoticeDataSchema = z.object({
  destination: z.string().min(1),
  key: z.string().min(1),
  conversationId: z.string().optional(),
  baseline: z.literal(true).optional(),
});
export type AttentionNoticeData = z.infer<typeof attentionNoticeDataSchema>;

export const attentionNoticeKindSchema = z.enum(['gate', 'attention', 'terminal']);
export type AttentionNoticeKind = z.infer<typeof attentionNoticeKindSchema>;
