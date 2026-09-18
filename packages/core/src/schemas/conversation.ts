/**
 * Zod schemas for conversation row types.
 */
import { z } from '@hono/zod-openapi';
import { identityPlatformSchema } from './user';

// Re-export so consumers don't need to import from user.ts directly
export { identityPlatformSchema };
export type { IdentityPlatform } from './user';

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/**
 * The colours a conversation may be labelled with. Names, not hex values, so the
 * UI owns the rendering and a theme change never has to rewrite stored rows.
 *
 * `null` means no colour, which is every conversation's default. The server
 * never interprets a colour; it is a visual label for scanning a chat list.
 */
export const CONVERSATION_COLORS = ['magenta', 'violet', 'teal', 'green', 'amber', 'red'] as const;

export const conversationColorSchema = z.enum(CONVERSATION_COLORS);
export type ConversationColor = z.infer<typeof conversationColorSchema>;

export const conversationRowSchema = z.object({
  id: z.string(),
  platform_type: z.string(),
  platform_conversation_id: z.string(),
  codebase_id: z.string().nullable(),
  cwd: z.string().nullable(),
  isolation_env_id: z.string().nullable(),
  ai_assistant_type: z.string(),
  title: z.string().nullable(),
  color: z.string().nullable(),
  hidden: z.boolean(),
  deleted_at: z.date().nullable(),
  last_activity_at: z.date().nullable(),
  user_id: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});

export type Conversation = z.infer<typeof conversationRowSchema>;
