/**
 * Zod schemas for workflow event row types.
 */
import { z } from 'zod';

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
  // Null for lifecycle rows written before event ordering was introduced.
  event_order: z.number().int().nullable().optional(),
});

export type WorkflowEventRow = z.infer<typeof workflowEventRowSchema>;

/** `workflow.checkout_shared` data: one fan-out sibling that shared this run's checkout. */
export const checkoutSharedEventDataSchema = z
  .object({
    parent_run_id: z.string().min(1),
    parent_node_id: z.string().min(1),
    working_path: z.string().min(1),
    sibling_run_id: z.string().min(1),
  })
  .catchall(z.unknown());

export type CheckoutSharedEventData = z.infer<typeof checkoutSharedEventDataSchema>;
