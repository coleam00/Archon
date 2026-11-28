/**
 * The linked items where an item stands depends on (`itemStanding`), each with whether it is
 * done: its parts, the items an active `part_of` link joins to it, and what it depends on, the
 * items its own active `depends_on` links point at.
 */
import { readHoldingItemEnd, type ItemEndStore } from './item-end';
import type { ItemLinkRead } from './schemas/item-link';
import type { WorkflowItem } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

/** Whether a linked item is done, and whether a cycle cut its reading short anywhere below. */
export interface PlacedDone {
  done: boolean;
  /**
   * An item met again inside its own links was taken as not done somewhere in this reading, so
   * the answer depends on the path it was reached by.
   */
  cut: boolean;
}

/**
 * A linked item is done when its change merged, else when `placedDone` says it stands `done`;
 * a part is also done when any end holds on it, as a work order counts its members
 * (`work-order.ts`). An item that is depended on counts as done only through `placedDone`:
 * an end the engine recorded for a finishing outcome stands it `done` (`item-standing.ts`),
 * so what depends on it goes on, while an operator's end leaves it `resting`, so what
 * depends on it still waits: that end says nothing more happens there, not that it delivered.
 * `inside` is `visiting` with the item, for the linked item's own links. An item met again
 * inside its own links is not done, so a cycle of links ends, and the read is `cut`. An
 * unreadable link joins nothing; the item read reports it.
 *
 * With `dependsOn: false` the item's own `depends_on` links are not read. A linked item is
 * placed only to ask whether it stands `done`, which its parts, merge and end decide before
 * what it depends on is looked at (`itemStanding`), so following them there could only
 * multiply the reads (#286). `known` holds, by id, whether a linked item stands `done`, shared
 * by every placement of one read, so converging links place a linked item once rather than
 * once per path to it. Only an answer no cycle cut is kept: that one is the same whichever
 * path reaches the item, while a cut one depends on the items above it.
 */
export async function readLinked(
  store: ItemEndStore & Pick<IWorkflowStore, 'getItemMerge'>,
  item: WorkflowItem,
  links: readonly ItemLinkRead[],
  visiting: ReadonlySet<string>,
  placedDone: (other: WorkflowItem, inside: ReadonlySet<string>) => Promise<PlacedDone>,
  options: { dependsOn: boolean; known: Map<string, boolean> }
): Promise<{ parts: { done: boolean }[]; dependsOn: { done: boolean }[]; cut: boolean }> {
  const inside = new Set([...visiting, item.id]);
  let cut = false;
  // An end row that does not read does not hold.
  const holdsEnd = async (id: string): Promise<boolean> => {
    const end = await readHoldingItemEnd(store, id);
    return end !== null && !('type' in end);
  };
  const done = async (other: WorkflowItem): Promise<boolean> => {
    // A merge row that does not read still says the change merged.
    if ((await store.getItemMerge(other.id)) !== null) return true;
    // Guarded by the id it is reached by, before it is placed, so a cycle ends however the
    // store resolves the item.
    if (inside.has(other.id)) {
      cut = true;
      return false;
    }
    const known = options.known.get(other.id);
    if (known !== undefined) return known;
    const placed = await placedDone(other, new Set([...inside, other.id]));
    if (placed.cut) cut = true;
    else options.known.set(other.id, placed.done);
    return placed.done;
  };
  const parts: { done: boolean }[] = [];
  const dependsOn: { done: boolean }[] = [];
  for (const link of links) {
    if ('type' in link || link.ended !== null) continue;
    if (link.kind === 'part_of' && link.to.id === item.id)
      parts.push({ done: (await holdsEnd(link.from.id)) || (await done(link.from)) });
    else if (options.dependsOn && link.kind === 'depends_on' && link.from.id === item.id)
      dependsOn.push({ done: await done(link.to) });
  }
  return { parts, dependsOn, cut };
}
