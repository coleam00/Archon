/**
 * Zod schemas for codebase row types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Codebase
// ---------------------------------------------------------------------------

export const codebaseRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  repository_url: z.string().nullable(),
  default_cwd: z.string(),
  ai_assistant_type: z.string(),
  commands: z.record(z.string(), z.object({ path: z.string(), description: z.string() })),
  created_at: z.date(),
  updated_at: z.date(),
});

export type Codebase = z.infer<typeof codebaseRowSchema>;
