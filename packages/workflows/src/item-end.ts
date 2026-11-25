/**
 * The one rule for whether an item's end holds, read by the item read and by the attention
 * queue's stopped items. The store answers for runs and queued starts
 * (`getHoldingItemEnd`); a trigger start not yet prepared names its item by key only, so it
 * is checked here. An end whose row cannot be read does not hold: the item shows as before.
 */
import type { ItemEnd, ItemEndDegraded } from './schemas/item-end';
import type { IWorkflowStore } from './store';

export type ItemEndStore = Pick<IWorkflowStore, 'getHoldingItemEnd' | 'listHeldItemStarts'>;

/** The end that holds on item `itemId`, the unreadable end in its place, or null. */
export async function readHoldingItemEnd(
  store: ItemEndStore,
  itemId: string
): Promise<ItemEnd | ItemEndDegraded | null> {
  const end = await store.getHoldingItemEnd(itemId);
  if (end === null || 'type' in end) return end;
  return (await store.listHeldItemStarts(itemId)).length === 0 ? end : null;
}
