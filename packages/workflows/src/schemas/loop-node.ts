import { z } from 'zod';
import { dagNodeBaseSchema } from './dag-node-base';
import { execNodeSchema } from './exec-node';
import { loopNodeConfigSchema } from './loop';
import { loopRetryConfigSchema } from './retry';

// The loop makes its own provider call. Its supported AI fields own both the
// authored projection and its ignored-field list (`LOOP_NODE_AI_FIELDS`).
export const loopAiAuthoringSchema = dagNodeBaseSchema.pick({
  model: true,
  provider: true,
  pi: true,
  allowed_tools: true,
  denied_tools: true,
  output_format: true,
});

/**
 * Loop node schema — extends base with `loop` config.
 * The authored AI projection selects fields consumed by each iteration; remaining
 * AI fields warn as ignored. Retry policy applies to each failed iteration.
 */
export const loopNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('loop'),
  retry: loopRetryConfigSchema.optional(),
  loop: loopNodeConfigSchema,
  timeout: execNodeSchema.shape.timeout,
});

/** DAG node that runs an AI prompt in a loop until a completion condition is met */
export type LoopNode = z.infer<typeof loopNodeSchema>;
