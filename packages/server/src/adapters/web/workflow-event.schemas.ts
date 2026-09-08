import { z } from '@hono/zod-openapi';
import {
  nodeSkipReasonSchema as engineNodeSkipReasonSchema,
  skipCauseSchema as engineSkipCauseSchema,
} from '@archon/workflows/schemas/workflow-run';

export const skipCauseSchema = engineSkipCauseSchema.openapi('SkipCause');
export const nodeSkipReasonSchema = engineNodeSkipReasonSchema.openapi('NodeSkipReason');

export const dagNodeSseEventSchema = z
  .object({
    type: z.literal('dag_node'),
    runId: z.string(),
    nodeId: z.string(),
    name: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'skipped']),
    duration: z.number().optional(),
    error: z.string().optional(),
    reason: nodeSkipReasonSchema.optional(),
    cause: skipCauseSchema.optional(),
    timestamp: z.number(),
  })
  .openapi('DagNodeSseEvent');

export type DagNodeSseEvent = z.infer<typeof dagNodeSseEventSchema>;
