/**
 * The board's Table view: one row per item the board shows, with the card's own values as
 * columns (`CardProgress`), sortable by any of them. Nothing here computes a value a card does
 * not show, apart from the time to merged, which the Overview's median reads too.
 */
import { ensureUtc } from '../../lib/format';
import type { ItemRead } from '../../skills/items';
import { CHIP } from '../../routes/board/standing';
import { timeToMerged } from './board-numbers';
import { shownChip } from './item-asks';
import type { CardProgress } from './item-card';
import { orderOf } from './work-orders';

export const TABLE_COLUMNS = [
  { id: 'key', label: 'Item' },
  { id: 'title', label: 'Title' },
  { id: 'order', label: 'Work order' },
  { id: 'column', label: 'Column' },
  { id: 'state', label: 'State' },
  { id: 'round', label: 'Round' },
  { id: 'returned', label: 'Returned' },
  { id: 'change', label: 'Change' },
  { id: 'merged', label: 'Merged' },
  { id: 'toMerge', label: 'To merge' },
] as const;
export type TableColumnId = (typeof TABLE_COLUMNS)[number]['id'];

export interface TableRow {
  read: ItemRead;
  /** The board column the card is in, by name. */
  column: string;
  /** Left to right on the board. */
  columnOrder: number;
}

export interface TableSort {
  by: TableColumnId;
  descending: boolean;
}

const CHIP_ORDER = Object.keys(CHIP);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * What a row sorts by in one column: a number, or text compared numerically-aware; null for a
 * row with no time to merge, which sorts after every time either way.
 */
function sortValue(
  row: TableRow,
  progress: CardProgress,
  by: TableColumnId
): number | string | null {
  const { read } = row;
  switch (by) {
    case 'key':
      return progress.keyText;
    case 'title':
      return progress.title;
    case 'order':
      return orderOf(read)?.key ?? '';
    case 'column':
      return row.columnOrder;
    case 'state':
      // An item with open asks, whose cell carries its Needs you button, sorts as Needs you.
      return CHIP_ORDER.indexOf(shownChip(read, progress.asks !== null));
    case 'round':
      return progress.round?.dots.length ?? 0;
    case 'returned':
      return progress.returned?.count ?? 0;
    case 'change':
      return progress.pr?.number ?? 0;
    case 'merged':
      // ISO times sort as text.
      return read.merged?.at ?? '';
    case 'toMerge':
      return timeToMerged(read);
  }
}

/** The rows sorted by one column; ties keep board order. */
export function sortRows(
  rows: readonly TableRow[],
  sort: TableSort,
  progressOf: (read: ItemRead) => CardProgress
): TableRow[] {
  const sign = sort.descending ? -1 : 1;
  const value = (row: TableRow): number | string | null =>
    sortValue(row, progressOf(row.read), sort.by);
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : collator.compare(String(left), String(right));
    return sign * order;
  });
}

/** A time in the Table's Merged cell: month, day, hour and minute, local ("Nov 17, 14:05"). */
export function shortDateTime(iso: string): string {
  return new Date(ensureUtc(iso)).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}
