import { describe, expect, test } from 'bun:test';
import { boardModel, filterBoard } from './board';
import { BOARD_SHOWS, parseBoardShow } from './board-show';
import { FIXTURE_NOW, PAGE, VIEW } from './board.test-fixtures';

describe('the board shows a number opens', () => {
  test('each of the shows parses; an unknown one is none, and leaves the whole board', () => {
    for (const show of BOARD_SHOWS) expect(parseBoardShow(show)).toBe(show);
    expect(parseBoardShow('bogus')).toBeUndefined();
    const model = boardModel(VIEW, 'cb-1', PAGE.items, new Map(), FIXTURE_NOW);
    expect(filterBoard(model, '', parseBoardShow('bogus'), FIXTURE_NOW)).toBe(model);
  });

  test('Unknown narrows the board to the items whose merge state could not be read', () => {
    const model = boardModel(VIEW, 'cb-1', PAGE.items, new Map(), FIXTURE_NOW);
    const keys = filterBoard(model, '', 'unknown', FIXTURE_NOW).columns.flatMap(column =>
      column.cards.map(placed => placed.card.key)
    );
    // Item 3's change is `unknown`; item 8's is too, but a run works it, so it is placed and
    // counted by that run.
    expect(keys).toEqual(['3']);
  });
});
