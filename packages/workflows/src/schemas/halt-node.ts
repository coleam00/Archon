import { z } from 'zod';
import { dagNodeBaseSchema } from './dag-node-base';

/**
 * Halt node schema (formerly `cancel:`) — terminates the workflow run with a reason string.
 * Extends full base for type compatibility; AI-specific fields are ignored at runtime.
 */
export const haltNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('halt'),
  reason: z.string().min(1, "'cancel' reason must not be empty"),
});

/** DAG node that cancels the workflow run with a reason string */
export type HaltNode = z.infer<typeof haltNodeSchema>;
