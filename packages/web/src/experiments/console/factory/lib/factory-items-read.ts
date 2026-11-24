import { getFactoryProgress, type FactoryItem, type FactoryProgress } from '../../skills/factory';
import { listItemWindow, type ItemRead, type ItemWindow } from '../../skills/items';
import type { WithinDeadline } from './deadline';
import { membershipOf } from './work-orders';

/**
 * A window start before any run, so every item with a run shows. The window lists an item
 * once one of its own runs started in it, so an item whose only start is still queued shows
 * from its first run on.
 */
const EVERY_ITEM_SINCE = '1970-01-01T00:00:00Z';
/** The most items one window page holds (`ITEM_WINDOW_MAX_LIMIT` on the server). */
export const PAGE_LIMIT = 100;

export interface FactoryItemsReads {
  listWindow: typeof listItemWindow;
  getProgress: typeof getFactoryProgress;
}

/** The skills the walk reads through in the console. */
export const FACTORY_ITEMS_READS: FactoryItemsReads = {
  listWindow: listItemWindow,
  getProgress: getFactoryProgress,
};

/** An item's latest activity: the latest of its runs' end, or start while one runs. */
function activityOf(item: ItemRead): number {
  return Math.max(0, ...item.runs.map(run => Date.parse(run.completedAt ?? run.startedAt)));
}

/**
 * Every non-empty page of a project's items window, in order: the window from before any
 * run, paged by its cursor. Each request has its own deadline.
 */
async function* windowPages(
  codebaseId: string,
  listWindow: FactoryItemsReads['listWindow'],
  within: WithinDeadline
): AsyncGenerator<ItemRead[]> {
  let after: string | null = null;
  do {
    const query: Parameters<FactoryItemsReads['listWindow']>[0] =
      after === null
        ? { project: codebaseId, since: EVERY_ITEM_SINCE, limit: PAGE_LIMIT }
        : { project: codebaseId, after, limit: PAGE_LIMIT };
    const page: ItemWindow = await within(signal => listWindow(query, { signal }));
    if (page.items.length > 0) yield page.items;
    after = page.next;
  } while (after !== null);
}

/**
 * Every item of a project as the engine reads it, with no factory view: the window alone,
 * never the factory progress read (which answers 404 where no view applies). Needs you reads
 * it for its Answered lately on such a project. Newest activity first, ties by item id.
 */
export async function readEveryItem(
  codebaseId: string,
  listWindow: FactoryItemsReads['listWindow'],
  within: WithinDeadline
): Promise<ItemRead[]> {
  const items: ItemRead[] = [];
  for await (const page of windowPages(codebaseId, listWindow, within)) items.push(...page);
  return items.sort((a, b) => activityOf(b) - activityOf(a) || a.item.id.localeCompare(b.item.id));
}

/** What `K.factoryItems(projectId)` holds for every Factory page. */
export interface FactoryItemsRead {
  /** Every item with a run, newest activity first, ties by item id. */
  items: FactoryItem[];
  /**
   * For each item the reads asked about (every item in `items`, and every work order an item
   * names that `items` lacks), the keys of the items with an active `part_of` link to it. A
   * named order absent here has no item row in the project.
   */
  members: Record<string, string[]>;
}

/**
 * Every item of one project, newest activity first, ties by item id, with the members of
 * every work order they name: the value `K.factoryItems(projectId)` holds. It walks the engine's items
 * window page by page (the cursor carries the window), and joins each page with the
 * progress the board needs from `GET /api/factory/progress`. The window pages by item id,
 * and the board keeps input order within a column, so the order is set here. A failed page
 * or progress read fails the whole read: a partial list would drop a running item without
 * a sign. Each request has its own deadline, not the walk: a large project's walk is many
 * requests, each quick. A work order the window lacks (it has no run of its own, or no item
 * row at all) is read after the walk, all of them in one progress request per page of keys,
 * never one per item.
 */
export async function readEveryFactoryItem(
  codebaseId: string,
  reads: FactoryItemsReads,
  within: WithinDeadline
): Promise<FactoryItemsRead> {
  const items: FactoryItem[] = [];
  const members: Record<string, string[]> = {};
  for await (const page of windowPages(codebaseId, reads.listWindow, within)) {
    const keys = page.map(read => read.item.key);
    const read = await within(signal => reads.getProgress({ codebaseId, keys }, { signal }));
    for (const item of page)
      items.push({ ...item, progress: read.progress[item.item.key] ?? null });
    Object.assign(members, read.members);
  }
  const outside = [...namedOrders(items)].filter(key => !(key in members));
  for (let start = 0; start < outside.length; start += PAGE_LIMIT) {
    const keys = outside.slice(start, start + PAGE_LIMIT);
    const read = await within(signal => reads.getProgress({ codebaseId, keys }, { signal }));
    Object.assign(members, read.members);
  }
  items.sort((a, b) => activityOf(b) - activityOf(a) || a.item.id.localeCompare(b.item.id));
  return { items, members };
}

/**
 * `read` with the progress of every item `answer` names, and its members merged in: what a
 * keyed progress read changes. A key the answer names as `null` takes it (the server could
 * not derive that item's progress); an item the answer omits stays as it was. The order is
 * kept: a progress read changes no item's activity.
 */
export function withProgress(read: FactoryItemsRead, answer: FactoryProgress): FactoryItemsRead {
  return {
    items: read.items.map(item =>
      Object.hasOwn(answer.progress, item.item.key)
        ? { ...item, progress: answer.progress[item.item.key] ?? null }
        : item
    ),
    members: { ...read.members, ...answer.members },
  };
}

/** Every work order an item is part of (`membershipOf`: its link, else its order run's result). */
function namedOrders(items: readonly FactoryItem[]): Set<string> {
  const orders = new Set<string>();
  for (const item of items) {
    const order = membershipOf(item)?.order;
    if (order !== undefined) orders.add(order);
  }
  return orders;
}
