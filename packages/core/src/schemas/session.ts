/**
 * Zod schemas for session row types.
 */
import { z } from '@hono/zod-openapi';
import type { TransitionTrigger } from '../state/session-transitions';

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
  // TODO(#1787-followup): TransitionTrigger is a type-only union.
  // z.custom() provides no runtime validation. When DB parsing is enabled,
  // replace with a refinement or const array exported from session-transitions.ts.
  transition_reason: z.custom<TransitionTrigger>().nullable(),
  ended_reason: z.custom<TransitionTrigger>().nullable(),
});

export type Session = z.infer<typeof sessionRowSchema>;
