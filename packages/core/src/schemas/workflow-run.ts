/**
 * Zod schemas for workflow run requests and dashboard types (enriched JOIN results).
 */
import { z } from '@hono/zod-openapi';

const signalWorkflowWaitFields = z.object({
  event: z.string().min(1),
  occurrence: z.string().min(1).optional(),
  resumeAt: z.iso.datetime().optional(),
  payload: z.unknown().optional(),
});

export const signalWorkflowWaitRequestSchema = z.union([
  signalWorkflowWaitFields.required({ occurrence: true }),
  signalWorkflowWaitFields.required({ resumeAt: true }),
]);

export type SignalWorkflowWaitRequest = z.infer<typeof signalWorkflowWaitRequestSchema>;

/**
 * What the serving process observes about a running run's execution owner, by the rule
 * `workflow wait` uses for `owner_lost`. `reachable`: an owner answers. `unreachable`: the
 * recorded owner is on this host and user and no endpoint answers on two reads.
 * `unknown`: this process cannot tell (another host or user, no recorded owner, or no
 * answer in time). Observed per read and never persisted; it never changes the status.
 */
export const runOwnerObservationSchema = z.enum(['reachable', 'unreachable', 'unknown']);

export type RunOwnerObservation = z.infer<typeof runOwnerObservationSchema>;

export * from '@archon/workflows/schemas/workflow-run-listing';
