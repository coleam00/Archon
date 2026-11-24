import type { FactoryItem } from '../../skills/factory';

/** The most suggestions a search lists: enough to find a mistyped key, short enough to read. */
export const ITEM_SEARCH_LIMIT = 8;

/**
 * The items that best match `query`, for a page that names an item the project does not have.
 * Ranked: the key itself, then keys that start with the query, then keys that hold it, then
 * titles that hold it, case-insensitive. Within a rank the input order holds (the items read is
 * newest activity first). An item with no progress is titled by its key, as on the board.
 */
export function closestItems(
  items: readonly FactoryItem[],
  query: string,
  limit = ITEM_SEARCH_LIMIT
): FactoryItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  // A stable sort keeps the input order within a rank.
  return items
    .map(item => ({ item, rank: rankOf(item, needle) }))
    .filter((entry): entry is { item: FactoryItem; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(entry => entry.item);
}

function rankOf(item: FactoryItem, needle: string): number | undefined {
  const key = item.item.key.toLowerCase();
  if (key === needle) return 0;
  if (key.startsWith(needle)) return 1;
  if (key.includes(needle)) return 2;
  if ((item.progress?.title ?? item.item.key).toLowerCase().includes(needle)) return 3;
  return undefined;
}
