/**
 * The branch an item's change lands on: a fresh run on the item is cut from it and
 * proposes against it, as `--base` makes a run do. An item that records none lands where
 * the item it is `part_of` lands (`resolveItemLanding`).
 */
import { z } from 'zod';
import { attentionAnsweringRunSchema } from './run-wait';
import { workflowItemSchema } from './workflow-run';

export const itemLandingSchema = z.object({
  branch: z.string().min(1),
  /** When the branch was last recorded; recording again replaces it. */
  recordedAt: z.string().datetime(),
  /** The run and node the call came from, reported by its environment and not verified. */
  fromRun: attentionAnsweringRunSchema.nullable(),
});
export type ItemLanding = z.infer<typeof itemLandingSchema>;

/** A landing row the store could not read. A run on the item is refused, not cut from the base. */
export const itemLandingDegradedSchema = z.object({
  type: z.literal('degraded'),
  reason: z.literal('landing_unreadable'),
  itemId: z.string(),
});
export type ItemLandingDegraded = z.infer<typeof itemLandingDegradedSchema>;

export interface ItemLandingReport {
  projectKey: string;
  key: string;
  branch: string;
  fromRun: z.infer<typeof attentionAnsweringRunSchema> | null;
}

/**
 * The branch a run on an item lands on and where it came from: the item's own record, or
 * the nearest item it is `part_of` that records one.
 */
export const resolvedItemLandingSchema = z.object({
  branch: z.string().min(1),
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('own') }),
    z.object({ kind: z.literal('part_of'), item: workflowItemSchema }),
  ]),
});
export type ResolvedItemLanding = z.infer<typeof resolvedItemLandingSchema>;

/** The item read could not say where the item lands; a run on it would be refused. */
export const itemLandingUnresolvedSchema = z.object({
  type: z.literal('degraded'),
  reason: z.literal('landing_unresolved'),
  message: z.string(),
});
