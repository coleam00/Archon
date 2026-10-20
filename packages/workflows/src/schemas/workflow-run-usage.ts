import { z } from 'zod';

export const workflowRunUsageSchema = z.object({
  total_cost_usd: z.number().nullable().optional(),
  total_tokens_in: z.number().nullable().optional(),
  total_tokens_out: z.number().nullable().optional(),
  total_tokens_unknown: z.boolean().optional(),
  total_cache_read_tokens: z.number().nullable().optional(),
  total_cache_write_tokens: z.number().nullable().optional(),
  total_cache_partial: z.boolean().nullable().optional(),
});

export type WorkflowRunUsage = z.infer<typeof workflowRunUsageSchema>;

// Persisted metadata predates typed usage; readers must narrow historical values.
export type WorkflowRunUsageRead = { [Key in keyof WorkflowRunUsage]?: unknown };
