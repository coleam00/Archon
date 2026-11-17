import { z } from 'zod';

export const WORKFLOW_TOOL_CALL_EVENT_TYPE = 'workflow_tool_call' as const;

/** Durable pointer to one Engine-owned script-tool transition; payloads stay in artifacts. */
export const workflowToolCallSchema = z.looseObject({
  call_id: z.string().uuid(),
  run_id: z.string().min(1),
  node_id: z.string().min(1),
  attempt_id: z.string().min(1),
  tool_name: z.string().min(1),
  provider_call_id: z.string().min(1),
  input_ref: z.string().min(1),
  output_ref: z.string().min(1).optional(),
  status: z.enum(['started', 'completed', 'failed', 'outcome_unknown']),
  error: z.string().optional(),
  recorded_at: z.string().datetime(),
});

export type WorkflowToolCall = z.infer<typeof workflowToolCallSchema>;

export const workflowToolCallListingSchema = z.object({
  runId: z.string(),
  calls: z.array(workflowToolCallSchema),
});
