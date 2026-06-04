/**
 * Zod schemas for codebase environment variable row types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// CodebaseEnvVar
// ---------------------------------------------------------------------------

export const codebaseEnvVarSchema = z.object({
  id: z.string(),
  codebase_id: z.string(),
  key: z.string(),
  value: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CodebaseEnvVar = z.infer<typeof codebaseEnvVarSchema>;
