/**
 * A start on an item from a trigger's binding that is not yet prepared (held), as the item
 * read lists it, and as the read of many items lists the held starts that name an item.
 */
import { z } from 'zod';
import type { HeldStart } from '../resource-start-store';

/** A held `trigger` start on one item, as the item read lists it. */
export type HeldItemStart = Pick<
  Extract<HeldStart, { kind: 'trigger' }>,
  'receiptId' | 'bindingId' | 'hostId' | 'workflow' | 'receivedAt'
>;

/**
 * A held start that names an item, as the read of many items lists it: with the project its
 * checkout is in, or, when that checkout matches more than one registered project, with
 * `unplaced`, the reason it could not be placed. An unplaced start belongs to no item's
 * standing; every item with its key reports it as degraded.
 */
export type ItemNamingHeldStart = HeldItemStart & { itemKey: string } & (
    | { projectKey: string }
    | { projectKey: null; unplaced: string }
  );

/**
 * A start on the item from a trigger's binding that is not yet prepared, so it has no
 * request or run. Under the install hold it waits for the lift; otherwise for the next
 * drain of its host (`hostId`), which prepares it and admits, queues or skips it by its
 * binding's `overlap`. `workflow` is null when the stored binding does not read.
 */
export const itemHeldStartSchema = z.object({
  receiptId: z.string(),
  bindingId: z.string(),
  hostId: z.string().nullable(),
  workflow: z.string().nullable(),
  receivedAt: z.string(),
});
export type ItemHeldStart = z.infer<typeof itemHeldStartSchema>;

/**
 * A held start naming the item's key whose checkout matches more than one registered project,
 * so it could not be placed in any (`ItemNamingHeldStart`). It is not in `held` and does not
 * count toward `standing`; every item with its key reports it, since its project is unknown.
 * `message` says why.
 */
export const heldStartUnplacedSchema = z.object({
  type: z.literal('degraded'),
  reason: z.literal('held_start_unplaced'),
  receiptId: z.string(),
  workflow: z.string().nullable(),
  message: z.string(),
});

/** The `held_start_unplaced` reports of the unplaced starts naming `itemKey`. */
export function unplacedHeldStarts(
  held: readonly ItemNamingHeldStart[],
  itemKey: string
): z.infer<typeof heldStartUnplacedSchema>[] {
  return held.flatMap(start =>
    start.projectKey === null && start.itemKey === itemKey
      ? [
          {
            type: 'degraded' as const,
            reason: 'held_start_unplaced' as const,
            receiptId: start.receiptId,
            workflow: start.workflow,
            message: start.unplaced,
          },
        ]
      : []
  );
}
