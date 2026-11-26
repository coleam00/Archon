/**
 * The linked items where an item stands depends on (`itemStanding`), each with whether it is
 * done: its parts, the items an active `part_of` link joins to it, and what it depends on, the
 * items its own active `depends_on` links point at.
 */
import { readHoldingItemEnd, type ItemEndStore } from './item-end';
import type { ItemLinkRead } from './schemas/item-link';
import type { WorkflowItem } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

/**
 * A linked item is done when its change merged, else when `placedDone` says it stands `done`;
 * a part is also done when any end holds on it, as a work order counts its members
 * (`work-order.ts`). An item that is depended on counts as done only through `placedDone`:
 * an end the engine recorded for a finishing outcome stands it `done` (`item-standing.ts`),
 * so what depends on it goes on, while an operator's end leaves it `resting`, so what
 * depends on it still waits: that end says nothing more happens there, not that it delivered.
 * `inside` is `visiting` with the item, for the linked item's own links. An item met again
 * inside its own links is not done, so a cycle of links ends. An unreadable link joins
 * nothing; the item read reports it.
 */
export async function readLinked(
  store: ItemEndStore & Pick<IWorkflowStore, 'getItemMerge'>,
  item: WorkflowItem,
  links: readonly ItemLinkRead[],
  visiting: ReadonlySet<string>,
  placedDone: (other: WorkflowItem, inside: ReadonlySet<string>) => Promise<boolean>
): Promise<{ parts: { done: boolean }[]; dependsOn: { done: boolean }[] }> {
  const inside = new Set([...visiting, item.id]);
  // An end row that does not read does not hold.
  const holdsEnd = async (id: string): Promise<boolean> => {
    const end = await readHoldingItemEnd(store, id);
    return end !== null && !('type' in end);
  };
  const done = async (other: WorkflowItem): Promise<boolean> =>
    // A merge row that does not read still says the change merged.
    (await store.getItemMerge(other.id)) !== null ||
    // Guarded by the id it is reached by, before it is placed, so a cycle ends however the
    // store resolves the item.
    (!inside.has(other.id) && (await placedDone(other, new Set([...inside, other.id]))));
  const parts: { done: boolean }[] = [];
  const dependsOn: { done: boolean }[] = [];
  for (const link of links) {
    if ('type' in link || link.ended !== null) continue;
    if (link.kind === 'part_of' && link.to.id === item.id)
      parts.push({ done: (await holdsEnd(link.from.id)) || (await done(link.from)) });
    else if (link.kind === 'depends_on' && link.from.id === item.id)
      dependsOn.push({ done: await done(link.to) });
  }
  return { parts, dependsOn };
}
