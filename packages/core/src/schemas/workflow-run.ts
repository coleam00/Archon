/**
 * Zod schemas for workflow run requests and dashboard types (enriched JOIN results).
 */
import { z } from '@hono/zod-openapi';

export const signalWorkflowWaitRequestSchema = z.object({
  event: z.string().min(1),
  resumeAt: z.iso.datetime(),
  payload: z.unknown().optional(),
});

export type SignalWorkflowWaitRequest = z.infer<typeof signalWorkflowWaitRequestSchema>;

export * from '@archon/workflows/schemas/workflow-run-listing';
