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
import type { WorkflowItem } from './schemas/workflow-run';
import type { IWorkflowStore } from './store';

export const ITEM_WINDOW_DEFAULT_LIMIT = 20;
export const ITEM_WINDOW_MAX_LIMIT = 100;

/**
 * `items` holds every run of each item, not only those that started in the window: a
 * per-item figure such as rounds per merged item needs the item's whole history.
 */
export const itemWindowSchema = z.object({
  window: z.object({ since: z.string().datetime(), until: z.string().datetime() }),
  items: z.array(itemReadSchema),
  /** Pass as `after` to read the next page; null on the last one. */
  next: z.string().nullable(),
});
export type ItemWindow = z.infer<typeof itemWindowSchema>;

/**
 * A first page names its window (`since` and `until` in `archon metrics` syntax, both
 * optional); a later page names only the cursor it follows. `open` keeps the items that
 * are open (`true`: their `standing.state` is not `resting`) or the ones at rest (`false`);
 * a cursor does not carry it, so each page names it again.
 */
export interface ItemWindowQuery {
  since?: string;
  until?: string;
  limit?: number;
  after?: string;
  open?: boolean;
}

/** The query cannot be answered as given; surfaces report it as a refusal, not a failure. */
export class ItemWindowQueryError extends Error {}

const cursorSchema = z.strictObject({
  project: z.string(),
  since: z.string().datetime(),
  until: z.string().datetime(),
  after: z.string(),
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
      limit,
    };
  }
  try {
    return { ...resolveMetricsWindow(query, now), afterItemId: null, limit };
  } catch (error) {
    if (error instanceof MetricsQueryError) throw new ItemWindowQueryError(error.message);
    throw error;
  }
}

export interface ItemWindowSource extends ItemReadSource {
  store: ItemReadSource['store'] & Pick<IWorkflowStore, 'listItemsInWindow'>;
}

/** The item read whole when `open` keeps it (see `ItemWindowQuery`), else null. */
async function keptRead(
  source: ItemWindowSource,
  item: WorkflowItem,
  install: Awaited<ReturnType<typeof readInstallFacts>>,
  open: boolean | undefined
): Promise<ItemRead | null> {
  const placed = await placeItem(source, item, install);
  // Items are never deleted, so one the window listed is still there.
  if (placed === null) throw new Error(`Item '${item.key}' was listed but not found`);
  return open === undefined || open === (placed.standing.state !== 'resting')
    ? placed.read()
    : null;
}

/**
 * One page of the project's items in the window. What the install holds for every item is
 * read once a page. Where an item stands is decided by `placeItem`, so `open` filters on it
 * and only a kept item is read whole: the store lists until the page is full or the window
 * is exhausted.
 */
export async function readItemWindow(
  source: ItemWindowSource,
  projectKey: string,
  query: ItemWindowQuery,
  now: Date = new Date()
): Promise<ItemWindow> {
  const { since, until, afterItemId, limit } = resolveQuery(query, projectKey, now);
  const window = { since: since.toISOString(), until: until.toISOString() };
  const install = await readInstallFacts(source);
  const items: ItemRead[] = [];
  const page = (after: string | null): ItemWindow => ({
    window,
    items,
    next: after === null ? null : encodeCursor({ project: projectKey, ...window, after }),
  });
  let after = afterItemId;
  for (;;) {
    const listed = await source.store.listItemsInWindow({
      projectKey,
      since,
      until,
      afterItemId: after,
      limit: limit + 1,
    });
    for (const item of listed.slice(0, limit)) {
      after = item.id;
      const read = await keptRead(source, item, install, query.open);
      if (read !== null) items.push(read);
      if (items.length === limit) return page(item === listed.at(-1) ? null : after);
    }
    if (listed.length <= limit) return page(null);
  }
}
