/**
 * Zod schema for workflow node checkpoint rows.
 */
import { z } from '@hono/zod-openapi';

const dbTimestamp = z.union([z.date(), z.string()]);

export const workflowCheckpointRowSchema = z.object({
  workflow_run_id: z.string(),
  node_id: z.string(),
  retry_epoch: z.number().int().nonnegative(),
  checkpoint_ref: z.string(),
  commit_sha: z.string(),
  created_commit: z.boolean(),
  fallback_from_node_id: z.string().nullable(),
  created_at: dbTimestamp,
});

export type WorkflowCheckpointRow = z.infer<typeof workflowCheckpointRowSchema>;
