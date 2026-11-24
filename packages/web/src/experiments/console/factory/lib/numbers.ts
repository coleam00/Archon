/**
 * The Overview's numbers strip (DESIGN.md, "Overview page"), from the board's model. Each
 * count is the number of cards the board shows under that number's filter. The strip's
 * "need you" tile is not here: it counts the attention queue (`needsYouCount`).
 */
import { filterBoard, type BoardModel } from './board';
import type { BoardShow } from './board-show';
import { timeToLand } from './board-table';
import { mergePending } from './merge-pending';

export interface FactoryNumbers {
  inFlight: number;
  landedToday: number;
  /** N of "N of M merged". */
  landed: number;
  /** M of "N of M merged": every item on the board; the items set aside are not. */
  total: number;
  /** Median from an item's first declared run to its change merging; null when none landed. */
  medianToLandMs: number | null;
  /**
   * Whether some item on the board has a merge state still being read (`mergePending`): the
   * counts above leave it out, and the strip shows a skeleton beside them for it.
   */
  pending: boolean;
  /**
   * How many items on the board have a merge state that could not be read (`mergeUnknown`):
   * the counts above leave them out, and the strip says how many in words.
   */
  unknown: number;
}

const cardCount = (model: BoardModel): number =>
  model.columns.reduce((sum, column) => sum + column.cards.length, 0);

/** The median of `values`; the mean of the two middle ones for an even count. */
export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return null;
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

export function factoryNumbers(model: BoardModel, now: Date): FactoryNumbers {
  const shown = (show: BoardShow): BoardModel => filterBoard(model, '', show, now);
  const times = shown('median-to-land')
    .columns.flatMap(column => column.cards)
    .flatMap(placed => timeToLand(placed) ?? []);
  return {
    inFlight: cardCount(shown('in-flight')),
    landedToday: cardCount(shown('landed-today')),
    landed: cardCount(shown('landed')),
    total: cardCount(shown('landed-of-all')),
    medianToLandMs: median(times),
    pending: model.columns.some(column => column.cards.some(placed => mergePending(placed.item))),
    unknown: cardCount(shown('unknown')),
  };
}
