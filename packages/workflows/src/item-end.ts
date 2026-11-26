/**
 * The one rule for whether an item's end holds, read by the item read and by the attention
 * queue's stopped items. The store answers for runs (`getHoldingItemEnd`); the item's starts
 * that have no run yet are read with their roles (`listItemStarts`): a start of a step opens
 * the end, an observer's does not, and a binding not yet prepared has no role, so it opens the
 * end only once it is prepared as a step or its run exists. An end whose row cannot be read
 * does not hold: the item shows as before.
 */
import type { ItemEnd, ItemEndDegraded } from './schemas/item-end';
import type { IWorkflowStore } from './store';

export type ItemEndStore = Pick<IWorkflowStore, 'getHoldingItemEnd' | 'listItemStarts'>;

/** The end that holds on item `itemId`, the unreadable end in its place, or null. */
export async function readHoldingItemEnd(
  store: ItemEndStore,
  itemId: string
): Promise<ItemEnd | ItemEndDegraded | null> {
  const end = await store.getHoldingItemEnd(itemId);
  if (end === null || 'type' in end) return end;
  return (await store.listItemStarts(itemId)).some(start => start.role === 'step') ? null : end;
}
