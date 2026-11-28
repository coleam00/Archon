import { z } from 'zod';
import { workflowRunSchema, workflowRunStatusSchema, type WorkflowRunStatus } from './workflow-run';

/**
 * What the serving process observes about a running run's execution owner, by the rule
 * `workflow wait` uses for `owner_lost`. `reachable`: an owner answers. `unreachable`: the
 * recorded owner is on this host and user and no endpoint answers on two reads.
 * `unknown`: this process cannot tell (another host or user, no recorded owner, or no
 * answer in time). Observed per read and never persisted; it never changes the status.
 */
export const runOwnerObservationSchema = z.enum(['reachable', 'unreachable', 'unknown']);

export type RunOwnerObservation = z.infer<typeof runOwnerObservationSchema>;

// ---------------------------------------------------------------------------
// DashboardWorkflowRun
// ---------------------------------------------------------------------------

export const dashboardWorkflowRunSchema = workflowRunSchema.extend({
  codebase_name: z.string().nullable(),
  /**
   * The item this run is on, as its key reads in that item's project (`owner/repo#123`
   * for a forge item; the engine never parses it). Null for a run on none. Joined from
   * the item the run's stored `item_id` names, so a `workflow:` sub-run, which carries
   * no `item_id` of its own, reads as none here too.
   */
  item_key: z.string().nullable(),
  platform_type: z.string().nullable(),
  worker_platform_id: z.string().nullable(),
  parent_platform_id: z.string().nullable(),
  active_nodes: z.array(z.string().min(1)),
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
  status: z
    .union([workflowRunStatusSchema, z.tuple([workflowRunStatusSchema], workflowRunStatusSchema)])
    .optional(),
  codebaseId: z.string().optional(),
  parentRunIds: z.array(z.string()).optional(),
  excludeLeafStatuses: z.array(workflowRunStatusSchema).optional(),
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
    ...(Object.fromEntries(
      workflowRunStatusSchema.options.map(status => [status, z.number()])
    ) as Record<WorkflowRunStatus, z.ZodNumber>),
  }),
});

export type DashboardRunsResult = z.infer<typeof dashboardRunsResultSchema>;
