/**
 * An item's priority: one flag, the item's own or inherited from an item it is `part_of`
 * through active links, at any depth. A queued start of an item with priority goes ahead of
 * every ordinary queued start on its resource and host; within each group the queue stays
 * first in, first out. A slot already held is never taken.
 */
import { z } from 'zod';
import { attentionAnsweringRunSchema } from './run-wait';
import { workflowItemSchema } from './workflow-run';

/** Where an item's priority comes from. A read is null when the item has none. */
export const itemPrioritySchema = z.object({
  /** The item records priority itself (`archon workflow priority`). */
  own: z.boolean(),
  /** The items it is `part_of` (directly or further up) that record priority, by key. */
  inheritedFrom: z.array(workflowItemSchema),
});
export type ItemPriority = z.infer<typeof itemPrioritySchema>;

export interface ItemPriorityTarget {
  projectKey: string;
  key: string;
}

export interface ItemPriorityReport extends ItemPriorityTarget {
  /** The run and node the call came from, reported by its environment and not verified. */
  fromRun: z.infer<typeof attentionAnsweringRunSchema> | null;
}
