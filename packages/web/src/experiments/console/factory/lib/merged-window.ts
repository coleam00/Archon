/**
 * The Merged column's window: the Pipeline lists only recent merges, so the column stays
 * short, and links to the Table for the rest. Display only: the board model, its filters, the
 * Overview's numbers and the Table all see every merged item, so "N of M done" and
 * `?show=landed` keep agreeing.
 */
import { ensureUtc } from '../../lib/format';
import type { PlacedCard } from './board';
import { SHOW_PARAM, TABLE_VIEW, VIEW_PARAM, type BoardShow } from './board-show';
import { ORDER_PARAM } from './work-orders';

/** How many local calendar days the column lists, today included. */
export const MERGED_DAYS = 7;

const mergedMs = ({ item }: PlacedCard): number | null => {
  const at = item.progress?.change?.mergedAt ?? null;
  return at === null ? null : new Date(ensureUtc(at)).getTime();
};

/**
 * The cards merged on `now`'s local day or the `MERGED_DAYS - 1` local days before it, newest
 * first, and how many others there are. A card with no merge time counts as earlier: how
 * recent it is is unknown, and the Table lists it.
 */
export function mergedWindow(
  cards: readonly PlacedCard[],
  now: Date
): { recent: PlacedCard[]; earlier: number } {
  const since = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (MERGED_DAYS - 1)
  ).getTime();
  const recent = cards
    .map(placed => ({ placed, at: mergedMs(placed) }))
    .filter(
      (entry): entry is { placed: PlacedCard; at: number } => entry.at !== null && entry.at >= since
    )
    .sort((a, b) => b.at - a.at)
    .map(entry => entry.placed);
  return { recent, earlier: cards.length - recent.length };
}

/** The Table view filtered to every merged item, keeping a lit work order. */
export function earlierSearch(params: URLSearchParams): string {
  const show: BoardShow = 'landed';
  const next = new URLSearchParams({ [VIEW_PARAM]: TABLE_VIEW, [SHOW_PARAM]: show });
  const order = params.get(ORDER_PARAM);
  if (order !== null) next.set(ORDER_PARAM, order);
  return `?${next.toString()}`;
}
