/**
 * Zod schemas for workflow event row types.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Event data schemas
// ---------------------------------------------------------------------------

export const routeLoopDecisionEventDataSchema = z
  .object({
    from: z.string().min(1),
    outcome: z.enum(['positive', 'negative', 'exhausted']),
    to: z.string().min(1),
    condition: z.string(),
    condition_result: z.boolean(),
    negative_count: z.number().int().nonnegative(),
    max_iterations: z.number().int().min(1),
    attempt: z.number().int().min(1),
    execution_seq: z.number().int().min(1),
  })
  .passthrough();

export type RouteLoopDecisionEventData = z.infer<typeof routeLoopDecisionEventDataSchema>;

// ---------------------------------------------------------------------------
// WorkflowEventRow
// ---------------------------------------------------------------------------

export const workflowEventRowSchema = z
  .object({
    id: z.string(),
    workflow_run_id: z.string(),
    event_type: z.string(),
    step_index: z.number().nullable(),
    step_name: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })
  .superRefine((row, ctx) => {
    if (row.event_type !== 'node_routed') return;

    const result = routeLoopDecisionEventDataSchema.safeParse(row.data);
    if (result.success) return;

    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', ...issue.path],
        message: issue.message,
      });
    }
  });

export type WorkflowEventRow = z.infer<typeof workflowEventRowSchema>;

export const nodeRetryRequestedEventDataSchema = z.object({
  runId: z.string(),
  node_id: z.string(),
  retry_epoch: z.number().int().nonnegative(),
  invalidated_node_ids: z.array(z.string()),
  requester_surface: z.enum(['web', 'cli']),
  requester_user_id: z.string(),
  authorization_basis: z.string(),
});

export const nodeRetryResetEventDataSchema = z.object({
  node_id: z.string(),
  retry_epoch: z.number().int().nonnegative(),
  checkpoint_ref: z.string().nullable(),
  checkpoint_commit_sha: z.string().nullable(),
  safety_ref: z.string().nullable(),
  safety_commit_sha: z.string().nullable(),
  reset_skipped: z.boolean(),
});

export const nodeRetryFailedEventDataSchema = z.object({
  node_id: z.string(),
  retry_epoch: z.number().int().nonnegative(),
  setup_phase: z.string(),
  error: z.string(),
});

export type NodeRetryRequestedEventData = z.infer<typeof nodeRetryRequestedEventDataSchema>;
export type NodeRetryResetEventData = z.infer<typeof nodeRetryResetEventDataSchema>;
export type NodeRetryFailedEventData = z.infer<typeof nodeRetryFailedEventDataSchema>;
