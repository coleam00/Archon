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

export * from '@archon/workflows/schemas/workflow-run-listing';
