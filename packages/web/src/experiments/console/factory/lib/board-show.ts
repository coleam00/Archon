/**
 * What each number of the Overview's strip counts, as a board show (`?show=`): the strip
 * counts the cards the board shows under the same show, so a number and the board cannot
 * disagree. The tiles are plain figures; only the strip's unknown-merge line links to its show,
 * and a show's address still opens the board as it says. A show names the set; its spec says
 * how the board shows it: in which view, sorted how, with which rows marked, with which panel
 * open.
 */
import { ensureUtc } from '../../lib/format';
import type { Pill, PlacedCard } from './board';
import type { TableSort } from './board-table';
import { mergeUnknown, mergeUnsettled } from './merge-pending';

/** `?view=table` shows the board's Table view; Pipeline is the default. */
export const VIEW_PARAM = 'view';
export const TABLE_VIEW = 'table';
/** `?show=` shows what one of the Overview's numbers counts. */
export const SHOW_PARAM = 'show';

export const BOARD_SHOWS = [
  'in-flight',
  'needs-you',
  'landed-today',
  'landed',
  'landed-of-all',
  'median-to-land',
  'found',
  'unknown',
] as const;
export type BoardShow = (typeof BOARD_SHOWS)[number];

/** Which Table rows a show marks: the merged ones, or the median's (one row, or two). */
export type TableMark = 'landed' | 'median';

export interface BoardShowSpec {
  /** The show in plain words, as the board's chip says it ("Showing: in flight"). */
  label: string;
  /** Whether it narrows the board to the cards `showsCard` keeps; else the board is whole. */
  narrows: boolean;
  /** Whether it opens the Table view rather than the Pipeline. */
  table: boolean;
  /** The sort the Table opens on; the Table's own default when absent. */
  sort?: TableSort;
  mark?: TableMark;
  /** Whether it opens the board's "Found by the factory" panel with its findings listed. */
  panel?: true;
}

export const BOARD_SHOW: Record<BoardShow, BoardShowSpec> = {
  'in-flight': {
    label: 'in flight',
    narrows: true,
    table: false,
  },
  'needs-you': {
    label: 'needs you',
    narrows: true,
    table: false,
  },
  'landed-today': {
    label: 'merged today',
    narrows: true,
    table: false,
  },
  landed: {
    label: 'merged',
    narrows: true,
    table: false,
  },
  'landed-of-all': {
    label: 'every item, merged ones marked',
    narrows: true,
    table: true,
    mark: 'landed',
  },
  'median-to-land': {
    label: 'merged, by time to merge, median marked',
    narrows: true,
    table: true,
    sort: { by: 'toLand', descending: false },
    mark: 'median',
  },
  unknown: {
    label: 'merge state could not be read',
    narrows: true,
    table: false,
  },
  found: {
    label: 'found by the factory',
    narrows: false,
    table: false,
    panel: true,
  },
};

/** The `?show=` value as a show; undefined for one no show has, which leaves the board whole. */
export function parseBoardShow(value: string): BoardShow | undefined {
  return BOARD_SHOWS.find(show => show === value);
}

/** The board's search for `show`: the Table's view with it, when it opens the Table. */
export function boardShowSearch(show: BoardShow): string {
  const params = new URLSearchParams();
  if (BOARD_SHOW[show].table) params.set(VIEW_PARAM, TABLE_VIEW);
  params.set(SHOW_PARAM, show);
  return `?${params.toString()}`;
}

/** Whether `iso` falls on the same local calendar day as `now`. */
function sameLocalDay(iso: string, now: Date): boolean {
  const at = new Date(ensureUtc(iso));
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
}

/** Whether a card's state waits on a person: an open ask, or a declared `awaits` outcome. */
export const waitsOnYou = (pill: Pill): boolean => pill === 'needs-you' || pill === 'awaits';

/**
 * Whether the show `show` keeps `placed`, a card in a column (`boardModel` sets aside the
 * items with nothing left to happen, so a parked card in a column is one a start waits for).
 * In flight: outside the landed stage, its merge state known. Needs you: its pill says so, an item waiting on you with no ask (`awaits`) included.
 * Landed, and the median's: in the landed stage, its merge state known. Landed today: landed,
 * its change merged on `now`'s local day. Landed of all: anywhere on the board (the M of "N of
 * M"). Found narrows nothing (`filterBoard` never asks). An item placement found no column
 * for is in none. An item whose merge state is not known
 * (`mergeUnsettled`) is in no show that says what merged or what is in flight, as either might
 * be wrong. Unknown: on the board, its merge state could not be read (`mergeUnknown`), the set
 * the Overview's line names.
 */
export function showsCard(
  show: BoardShow,
  placed: PlacedCard,
  landedStage: string,
  now: Date
): boolean {
  const { column, card, item } = placed;
  if (column === null || 'ended' in column) return false;
  const unsettled = mergeUnsettled(item);
  const landed = column.stage.id === landedStage && !unsettled;
  switch (show) {
    case 'in-flight':
      return column.stage.id !== landedStage && !unsettled;
    case 'needs-you':
      return waitsOnYou(card.pill);
    case 'landed':
    case 'median-to-land':
      return landed;
    case 'landed-of-all':
    case 'found':
      return true;
    case 'unknown':
      return mergeUnknown(item);
    case 'landed-today': {
      const mergedAt = item.progress?.change?.mergedAt ?? null;
      return landed && mergedAt !== null && sameLocalDay(mergedAt, now);
    }
  }
}
