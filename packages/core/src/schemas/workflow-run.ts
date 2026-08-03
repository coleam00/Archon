/**
 * Zod schemas for dashboard workflow run types (enriched JOIN results).
 */
import { z } from '@hono/zod-openapi';
import { workflowRunSchema, workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';

// ---------------------------------------------------------------------------
// DashboardWorkflowRun
// ---------------------------------------------------------------------------

export const dashboardWorkflowRunSchema = workflowRunSchema.extend({
  codebase_name: z.string().nullable(),
  platform_type: z.string().nullable(),
  worker_platform_id: z.string().nullable(),
  parent_platform_id: z.string().nullable(),
  current_step_name: z.string().nullable(),
  total_steps: z.number().nullable(),
  current_step_status: z.enum(['running', 'completed', 'failed']).nullable(),
  agents_completed: z.number().nullable(),
  agents_failed: z.number().nullable(),
  agents_total: z.number().nullable(),
});

export type DashboardWorkflowRun = z.infer<typeof dashboardWorkflowRunSchema>;

// ---------------------------------------------------------------------------
// ListDashboardRunsOptions
// ---------------------------------------------------------------------------

export const listDashboardRunsOptionsSchema = z.object({
  status: workflowRunStatusSchema.optional(),
  codebaseId: z.string().optional(),
  search: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

export type ListDashboardRunsOptions = z.infer<typeof listDashboardRunsOptionsSchema>;

// ---------------------------------------------------------------------------
// DashboardRunsResult
// ---------------------------------------------------------------------------

export const dashboardRunsResultSchema = z.object({
  runs: z.array(dashboardWorkflowRunSchema),
  total: z.number(),
  counts: z.object({
    all: z.number(),
    running: z.number(),
    completed: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    pending: z.number(),
    paused: z.number(),
  }),
});

export type DashboardRunsResult = z.infer<typeof dashboardRunsResultSchema>;
