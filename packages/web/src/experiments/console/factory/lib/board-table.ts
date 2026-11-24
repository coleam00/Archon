/** The board's Table view: one row per item with the card's fields, sortable by any of them. */
import { ensureUtc } from '../../lib/format';
import { displayItemKey } from './item-key';
import { PILL_LABEL, type BoardModel, type Pill, type PlacedCard } from './board';
import type { TableMark } from './board-show';
import { stageIdOf, UNPLACED_LABEL } from './placement';

export const TABLE_COLUMNS = [
  { id: 'key', label: 'Item' },
  { id: 'title', label: 'Title' },
  { id: 'order', label: 'Work order' },
  { id: 'column', label: 'Column' },
  { id: 'stage', label: 'Stage' },
  { id: 'state', label: 'State' },
  { id: 'round', label: 'Round' },
  { id: 'returned', label: 'Returned' },
  { id: 'change', label: 'Change' },
  { id: 'merged', label: 'Merged' },
  { id: 'toLand', label: 'To merge' },
  { id: 'stop', label: 'Stopped by or asks' },
] as const;
export type TableColumnId = (typeof TABLE_COLUMNS)[number]['id'];

export interface TableRow {
  placed: PlacedCard;
  /** The column's label, or `UNPLACED_LABEL` for an item placement found no column for. */
  column: string;
  /** Left to right on the board; unplaced items after every column. */
  columnOrder: number;
  /**
   * The stage its board card names: null for an unplaced item, which is in none, and for a merged
   * one, whose Column and State already say so (`cardFields` leaves its card's stage empty).
   */
  stage: string | null;
  /** The stage's place on the board: columns left to right, then stages within one. */
  stageOrder: number;
}

export interface TableSort {
  by: TableColumnId;
  descending: boolean;
}

/**
 * Every row the board shows, columns first in board order, then the items placement found no
 * column for. The items set aside are no rows, as they are in no column.
 */
export function tableRows(model: BoardModel): TableRow[] {
  const stages = model.columns.flatMap(column => column.stages);
  const placed = model.columns.flatMap((column, order) =>
    column.cards.map(card => {
      const stage = card.column !== null && 'stage' in card.column ? card.column.stage : null;
      return {
        placed: card,
        column: column.label,
        columnOrder: order,
        stage: card.card.stage,
        stageOrder: stage === null ? stages.length : stages.indexOf(stage.id),
      };
    })
  );
  const unplaced = model.unplaced.map(card => ({
    placed: card,
    column: UNPLACED_LABEL,
    columnOrder: model.columns.length,
    stage: null,
    stageOrder: stages.length,
  }));
  return [...placed, ...unplaced];
}

const ms = (iso: string): number => new Date(ensureUtc(iso)).getTime();

/**
 * From the item's first declared run starting to its change merging; null for an item that
 * has not merged, has no merge time, or has no declared run the read carries. The Overview's
 * median and the Table's "To merge" column both read it.
 */
export function timeToLand({ item }: PlacedCard): number | null {
  const mergedAt = item.progress?.change?.mergedAt ?? null;
  if (mergedAt === null) return null;
  const declared = new Set(item.progress?.runs.map(run => run.runId));
  const starts = item.runs.filter(run => declared.has(run.id)).map(run => ms(run.startedAt));
  if (starts.length === 0) return null;
  return ms(mergedAt) - Math.min(...starts);
}

const PILL_ORDER: readonly Pill[] = Object.keys(PILL_LABEL) as Pill[];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * What a row sorts by in one column: a number, or text compared numerically-aware; null for a
 * row with no time to merge, which sorts after every time either way.
 */
function sortValue(row: TableRow, by: TableColumnId): number | string | null {
  const { card, item } = row.placed;
  switch (by) {
    case 'key':
      // By the key as the column shows it (#N), so issue-9 sorts before 111.
      return displayItemKey(card.key, card.order);
    case 'title':
      return card.title;
    case 'column':
      return row.columnOrder;
    case 'stage':
      return row.stageOrder;
    case 'state':
      return PILL_ORDER.indexOf(card.pill);
    case 'round':
      return item.progress?.round?.iteration ?? 0;
    case 'returned':
      return card.returned?.count ?? 0;
    case 'change':
      return item.progress?.change?.number ?? 0;
    case 'merged':
      // ISO times sort as text; only a merged card shows one.
      return card.mergedAt === null ? '' : (item.progress?.change?.mergedAt ?? '');
    case 'toLand':
      return timeToLand(row.placed);
    case 'stop':
      return card.stopLine ?? '';
    case 'order':
      return card.order === null ? '' : displayItemKey(card.order, null);
  }
}

/** The rows sorted by one column; ties keep board order. */
export function sortRows(rows: readonly TableRow[], sort: TableSort): TableRow[] {
  const sign = sort.descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, sort.by);
    const right = sortValue(b, sort.by);
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : collator.compare(String(left), String(right));
    return sign * order;
  });
}

/**
 * The keys of the rows `mark` marks. Landed: every row in the landed stage, the N of "N of M
 * merged". Median: of the rows with a time to merge, the middle one, or the two middle ones for
 * an even count (the median is their mean).
 */
export function markedKeys(
  rows: readonly TableRow[],
  mark: TableMark,
  landedStage: string
): ReadonlySet<string> {
  if (mark === 'landed')
    return new Set(rows.filter(row => stageIdOf(row.placed.column) === landedStage).map(keyOf));
  const timed = rows
    .map(row => ({ key: keyOf(row), time: timeToLand(row.placed) }))
    .filter((row): row is { key: string; time: number } => row.time !== null)
    .sort((a, b) => a.time - b.time);
  const mid = Math.floor(timed.length / 2);
  const middle = timed.length % 2 === 1 ? timed.slice(mid, mid + 1) : timed.slice(mid - 1, mid + 1);
  return new Set(middle.map(row => row.key));
}

const keyOf = (row: TableRow): string => row.placed.card.key;

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
