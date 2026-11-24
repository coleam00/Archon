/**
 * The read of a project's items over a window (`workflow items`, `GET /api/items/window`,
 * `items()` in `archon:script`): the items with one of their own runs started in the
 * window, each read whole as `readItem` reads it. Paged by item id under an opaque cursor
 * that pins the window, so following it returns each remaining item once.
 */
import { z } from 'zod';
import {
  itemReadSchema,
  placeItem,
  readInstallFacts,
  type ItemRead,
  type ItemReadSource,
} from './item-read';
import { MetricsQueryError, resolveMetricsWindow } from './metrics';
import { ITEM_STANDING_STATES, type ItemStanding } from './item-standing';
import { runPack } from './run-pack';
import type { WorkflowItem } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

export const ITEM_WINDOW_DEFAULT_LIMIT = 20;
export const ITEM_WINDOW_MAX_LIMIT = 100;

/**
 * `items` holds every run of each item, not only those that started in the window: a
 * per-item figure such as rounds per merged item needs the item's whole history.
 */
const count = z.number().int();
// One count per standing state; `satisfies` fails the build when a state is added without one.
const stateCounts = {
  running: count,
  waiting: count,
  queued: count,
  failed: count,
  stopped: count,
  done: count,
  resting: count,
} satisfies Record<ItemStanding['state'], z.ZodNumber>;

export const itemWindowSchema = z.object({
  window: z.object({ since: z.string().datetime(), until: z.string().datetime() }),
  items: z.array(itemReadSchema),
  /** Pass as `after` to read the next page; null on the last one. */
  next: z.string().nullable(),
  /**
   * With `states` or `pack` in the query: how many items of the window (of that pack, when
   * named) stand in each state, whatever the page holds. Null without either.
   */
  totals: z.object(stateCounts).nullable(),
});
export type ItemWindow = z.infer<typeof itemWindowSchema>;

/**
 * A first page names its window (`since` and `until` in `archon metrics` syntax, both
 * optional); a later page names only the cursor it follows.
 *
 * `states` keeps the items whose `standing.state` is one of them. `pack` keeps the items
 * whose standing run is a run of that pack (`runPack`'s key). With either, every item of the
 * window is placed, the page comes most recently active first (when its standing run ended,
 * or started), and the answer carries `totals`. A cursor does not carry them, so each page
 * names them again.
 */
export interface ItemWindowQuery {
  since?: string;
  until?: string;
  limit?: number;
  after?: string;
  states?: readonly ItemStanding['state'][];
  pack?: string;
}

/** The query cannot be answered as given; surfaces report it as a refusal, not a failure. */
export class ItemWindowQueryError extends Error {}

const cursorSchema = z.strictObject({
  project: z.string(),
  since: z.string().datetime(),
  until: z.string().datetime(),
  after: z.string(),
  /** How many items of a placed read (`states`, `pack`) precede the page; `after` is then unused. */
  offset: z.number().int().nonnegative().optional(),
});

function encodeCursor(cursor: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(text: string, projectKey: string): z.infer<typeof cursorSchema> {
  let parsed: z.ZodSafeParseResult<z.infer<typeof cursorSchema>>;
  try {
    parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')));
  } catch {
    throw new ItemWindowQueryError('after is not a cursor this read returned');
  }
  if (!parsed.success) throw new ItemWindowQueryError('after is not a cursor this read returned');
  if (parsed.data.project !== projectKey)
    throw new ItemWindowQueryError(`after is a cursor for another project, not ${projectKey}`);
  return parsed.data;
}

interface ResolvedQuery {
  since: Date;
  until: Date;
  afterItemId: string | null;
  offset: number;
  limit: number;
}

function resolveQuery(query: ItemWindowQuery, projectKey: string, now: Date): ResolvedQuery {
  const limit = query.limit ?? ITEM_WINDOW_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ITEM_WINDOW_MAX_LIMIT)
    throw new ItemWindowQueryError(
      `limit must be a whole number from 1 to ${String(ITEM_WINDOW_MAX_LIMIT)}`
    );
  if (query.after !== undefined) {
    if (query.since !== undefined || query.until !== undefined)
      throw new ItemWindowQueryError(
        'after carries its window; do not pass since or until with it'
      );
    const cursor = decodeCursor(query.after, projectKey);
    return {
      since: new Date(cursor.since),
      until: new Date(cursor.until),
      afterItemId: cursor.after,
      offset: cursor.offset ?? 0,
      limit,
    };
  }
  try {
    return { ...resolveMetricsWindow(query, now), afterItemId: null, offset: 0, limit };
  } catch (error) {
    if (error instanceof MetricsQueryError) throw new ItemWindowQueryError(error.message);
    throw error;
  }
}

export interface ItemWindowSource extends ItemReadSource {
  store: ItemReadSource['store'] & Pick<IWorkflowStore, 'listItemsInWindow'>;
}

type Install = Awaited<ReturnType<typeof readInstallFacts>>;

/** Every item of the window, in id order, read from the store a page at a time. */
async function listWindow(
  source: ItemWindowSource,
  range: { projectKey: string; since: Date; until: Date }
): Promise<WorkflowItem[]> {
  const items: WorkflowItem[] = [];
  for (;;) {
    const listed = await source.store.listItemsInWindow({
      ...range,
      afterItemId: items.at(-1)?.id ?? null,
      limit: ITEM_WINDOW_MAX_LIMIT,
    });
    items.push(...listed);
    if (listed.length < ITEM_WINDOW_MAX_LIMIT) return items;
  }
}

/** Place `item`; items are never deleted, so one the window listed is still there. */
async function placed(source: ItemWindowSource, item: WorkflowItem, install: Install) {
  const place = await placeItem(source, item, install);
  if (place === null) throw new Error(`Item '${item.key}' was listed but not found`);
  return place;
}

/**
 * A page of a placed read (`states`, `pack`): every item of the window is placed, which costs
 * a few reads each, and only the page's items are read whole.
 */
async function readPlacedPage(
  source: ItemWindowSource,
  range: { projectKey: string; since: Date; until: Date },
  query: ItemWindowQuery,
  page: { offset: number; limit: number },
  install: Install
): Promise<Pick<ItemWindow, 'items' | 'totals'> & { nextOffset: number | null }> {
  const totals = Object.fromEntries(ITEM_STANDING_STATES.map(state => [state, 0])) as Record<
    ItemStanding['state'],
    number
  >;
  const kept: { place: Awaited<ReturnType<typeof placed>>; at: number }[] = [];
  for (const item of await listWindow(source, range)) {
    const place = await placed(source, item, install);
    if (query.pack !== undefined && (place.run && runPack(place.run))?.key !== query.pack) continue;
    totals[place.standing.state] += 1;
    if (query.states === undefined || query.states.includes(place.standing.state))
      kept.push({
        place,
        at: (place.run?.completed_at ?? place.run?.started_at)?.getTime() ?? 0,
      });
  }
  // Stable, so items that tie keep the store's id order.
  kept.sort((a, b) => b.at - a.at);
  const end = page.offset + page.limit;
  const items: ItemRead[] = [];
  for (const { place } of kept.slice(page.offset, end)) items.push(await place.read());
  return { items, totals, nextOffset: end < kept.length ? end : null };
}

/**
 * One page of the project's items in the window. What the install holds for every item is
 * read once a page. Without `states` or `pack` the page follows the store's id order and reads
 * only its own items; with one, see `ItemWindowQuery`.
 */
export async function readItemWindow(
  source: ItemWindowSource,
  projectKey: string,
  query: ItemWindowQuery,
  now: Date = new Date()
): Promise<ItemWindow> {
  const { since, until, afterItemId, offset, limit } = resolveQuery(query, projectKey, now);
  const window = { since: since.toISOString(), until: until.toISOString() };
  const cursor = (after: string, next?: number): string =>
    encodeCursor({
      project: projectKey,
      ...window,
      after,
      ...(next === undefined ? {} : { offset: next }),
    });
  const install = await readInstallFacts(source);
  if (query.states !== undefined || query.pack !== undefined) {
    const range = { projectKey, since, until };
    const page = await readPlacedPage(source, range, query, { offset, limit }, install);
    return {
      window,
      items: page.items,
      next: page.nextOffset === null ? null : cursor('', page.nextOffset),
      totals: page.totals,
    };
  }
  const listed = await source.store.listItemsInWindow({
    projectKey,
    since,
    until,
    afterItemId,
    limit: limit + 1,
  });
  const items: ItemRead[] = [];
  for (const item of listed.slice(0, limit))
    items.push(await (await placed(source, item, install)).read());
  const last = listed.length > limit ? listed[limit - 1] : undefined;
  return { window, items, next: last === undefined ? null : cursor(last.id), totals: null };
}
