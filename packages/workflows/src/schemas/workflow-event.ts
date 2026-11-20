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

/**
 * `stall_message` data. `sent: true` is a message the engine handed the stalled session
 * (`count` of `limit` for that node attempt). `sent: false` is one the session did not
 * get: `reason: 'provider_refused'` when the provider's runtime refused the message it was
 * handed (`count` names that message, `error` is the provider's report), and
 * `reason: 'provider_unsupported'`, written once per attempt, when the provider cannot
 * take one, so the stall stays with attention and `end-turn`.
 */
export const stallMessageEventDataSchema = z.discriminatedUnion('sent', [
  z
    .object({
      sent: z.literal(true),
      sender: z.literal('engine'),
      provider: z.string(),
      iteration: z.number().int().positive().optional(),
      count: z.number().int().positive(),
      limit: z.number().int().positive(),
      open: z.array(
        z
          .object({
            toolCallId: z.string(),
            name: z.string(),
            title: z.string().optional(),
            openForMs: z.number().nonnegative(),
            noProgressMs: z.number().nonnegative(),
          })
          .catchall(z.unknown())
      ),
      text: z.string(),
    })
    .catchall(z.unknown()),
  z
    .object({
      sent: z.literal(false),
      reason: z.string(),
      provider: z.string(),
      iteration: z.number().int().positive().optional(),
      count: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      error: z.string().optional(),
    })
    .catchall(z.unknown()),
]);

export type StallMessageEventData = z.infer<typeof stallMessageEventDataSchema>;

/** One line naming what a `stall_message` record says, for status, progress and transcript text. */
export function describeStallMessage(
  step: string,
  runId: string,
  data: StallMessageEventData
): string {
  const where = data.iteration !== undefined ? `${step} iteration ${String(data.iteration)}` : step;
  const of =
    data.count !== undefined && data.limit !== undefined
      ? ` (${String(data.count)} of ${String(data.limit)})`
      : '';
  if (data.sent) return `[${where}] engine sent the stalled session a message${of}`;
  if (data.reason === 'provider_refused')
    return `[${where}] provider ${data.provider} refused the engine's message${of}: ${data.error ?? 'no reason given'}`;
  return `[${where}] provider ${data.provider} cannot take an engine message; end the stalled turn with archon workflow end-turn ${runId}`;
}
