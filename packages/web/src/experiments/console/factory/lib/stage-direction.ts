/**
 * Which way a hand-off between two stages goes, by the board's columns in order and a stage's
 * row inside its column: into an earlier column, or into the same stage or an earlier one of
 * the same column, is a send-back; anything else goes forward. The map's arrows follow it as
 * is. The item page judges a run from the furthest stage its workflow works and reads a
 * placement into that stage itself as sent on (`placedKind`, `lib/timeline.ts`).
 */
import { boardColumns } from './board-columns';
import type { FactoryDeclaration } from './board';

/** Where a stage sits: its column's (or map card's) index, and its row in that column. */
export interface Seat {
  card: number;
  row: number;
}

/** Whether a hand-off from the stage at `from` into the stage at `to` sends the item back. */
export function isSendBack(from: Seat, to: Seat): boolean {
  return to.card < from.card || (to.card === from.card && to.row <= from.row);
}

/** Every declared stage's seat on the board, by stage id. */
export function boardSeats(view: FactoryDeclaration): ReadonlyMap<string, Seat> {
  const seats = new Map<string, Seat>();
  boardColumns(view).forEach((column, card) => {
    column.stages.forEach((stage, row) => seats.set(stage, { card, row }));
  });
  return seats;
}
