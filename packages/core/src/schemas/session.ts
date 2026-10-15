/**
 * Zod schemas for session row types.
 */
import { z } from '@hono/zod-openapi';
export const SESSION_TRANSITION_REASONS = [
  'first-message',
  'plan-to-execute',
  'isolation-changed',
  'project-changed',
  'reset-requested',
  'worktree-removed',
  'conversation-closed',
  'cwd-changed',
] as const;

export type TransitionTrigger = (typeof SESSION_TRANSITION_REASONS)[number];

// ---------------------------------------------------------------------------
// SessionMetadata
// ---------------------------------------------------------------------------

export const sessionMetadataSchema = z
  .object({
    lastCommand: z.string().optional(),
  })
  .passthrough();

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const sessionRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  codebase_id: z.string().nullable(),
  ai_assistant_type: z.string(),
  assistant_session_id: z.string().nullable(),
  active: z.boolean(),
  metadata: sessionMetadataSchema,
  started_at: z.date(),
  ended_at: z.date().nullable(),
  parent_session_id: z.string().nullable(),
  transition_reason: z.enum(SESSION_TRANSITION_REASONS).nullable(),
  ended_reason: z.enum(SESSION_TRANSITION_REASONS).nullable(),
});

export type Session = z.infer<typeof sessionRowSchema>;
