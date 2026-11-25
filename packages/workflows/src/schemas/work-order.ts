/**
 * A work order: an item that other items are `part_of` through an active link. Its state
 * follows from its members and is derived on every read (`work-order.ts`); nothing stores
 * it and no stage ends it.
 */
import { z } from 'zod';
import { itemEndDegradedSchema } from './item-end';
import { itemLinkDegradedSchema } from './item-link';
import { itemMergeDegradedSchema } from './item-merge';
import { workflowItemSchema } from './workflow-run';

/**
 * A member's state: `merged` (a merge on record), `ended` (an end that holds), `done` (it
 * is a work order itself and every one of its members is merged, ended or done), `open`, or
 * `unknown` when a part it depends on could not be read.
 */
export const workOrderMemberStateSchema = z.enum(['open', 'merged', 'ended', 'done', 'unknown']);
export type WorkOrderMemberState = z.infer<typeof workOrderMemberStateSchema>;

/**
 * `open` while any member is open; `done` once every member is merged, ended or done;
 * `unknown` when none is open but one could not be read, or a link of the work order
 * itself could not be read. The members that keep it open are those whose state is `open`.
 */
export const workOrderSchema = z.object({
  state: z.enum(['open', 'done', 'unknown']),
  members: z.array(z.object({ item: workflowItemSchema, state: workOrderMemberStateSchema })),
});
export type WorkOrder = z.infer<typeof workOrderSchema>;

/**
 * A merge, end or link of a member (or of a member's member) that could not be read, with
 * the store's own report. It is kept apart from the item's own `merge_unreadable` and
 * `end_unreadable`, which are about the item read.
 */
export const workOrderMemberUnreadableSchema = z.object({
  type: z.literal('degraded'),
  reason: z.literal('member_unreadable'),
  member: workflowItemSchema,
  report: z.discriminatedUnion('reason', [
    itemMergeDegradedSchema,
    itemEndDegradedSchema,
    itemLinkDegradedSchema,
  ]),
});
export type WorkOrderMemberUnreadable = z.infer<typeof workOrderMemberUnreadableSchema>;
