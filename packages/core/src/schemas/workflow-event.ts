/**
 * Zod schemas for workflow event row types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// WorkflowEventRow
// ---------------------------------------------------------------------------

export const workflowEventRowSchema = z.object({
  id: z.string(),
  workflow_run_id: z.string(),
  event_type: z.string(),
  step_index: z.number().nullable(),
  step_name: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export type WorkflowEventRow = z.infer<typeof workflowEventRowSchema>;
