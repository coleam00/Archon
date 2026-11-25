/**
 * The linked items where an item stands depends on (`itemStanding`), each with whether it is
 * done: its parts, the items an active `part_of` link joins to it, and what it depends on, the
 * items its own active `depends_on` links point at.
 */
import type { ItemLinkRead } from './schemas/item-link';
import type { WorkflowItem } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

/**
 * A linked item is done when its change merged, else when `placedDone` says it stands `done`;
 * `inside` is `visiting` with the item, for the linked item's own links. An item met again
 * inside its own links is not done, so a cycle of links ends. An unreadable link joins
 * nothing; the item read reports it.
 */
export async function readLinked(
  store: Pick<IWorkflowStore, 'getItemMerge'>,
  item: WorkflowItem,
  links: readonly ItemLinkRead[],
  visiting: ReadonlySet<string>,
  placedDone: (other: WorkflowItem, inside: ReadonlySet<string>) => Promise<boolean>
): Promise<{ parts: { done: boolean }[]; dependsOn: { done: boolean }[] }> {
  const inside = new Set([...visiting, item.id]);
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
      parts.push({ done: await done(link.from) });
    else if (link.kind === 'depends_on' && link.from.id === item.id)
      dependsOn.push({ done: await done(link.to) });
  }
  return { parts, dependsOn };
}
