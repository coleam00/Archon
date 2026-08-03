/**
 * Zod schemas for message row types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// MessageRow
// ---------------------------------------------------------------------------

export const messageRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  metadata: z.string(),
  user_id: z.string().nullable(),
  created_at: z.string(),
});

export type MessageRow = z.infer<typeof messageRowSchema>;
