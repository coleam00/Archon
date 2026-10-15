/** Private provider session handles produced by nodes within one workflow run. */
import { z } from 'zod';

export const workflowRunNodeSessionSchema = z.object({
  workflow_run_id: z.string(),
  node_id: z.string(),
  provider: z.string(),
  provider_session_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type WorkflowRunNodeSession = z.infer<typeof workflowRunNodeSessionSchema>;
