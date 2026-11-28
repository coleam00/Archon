import { describe, expect, test } from 'bun:test';
import { OVERVIEW } from './overview.test-fixtures';
import { openView, viewList, viewTrail } from './overview-nav';

describe('viewTrail', () => {
  test('runs from the root, named by its title, to the view, named by the card that opens it', () => {
    expect(viewTrail(OVERVIEW, 'test')).toEqual([
      { id: 'top', label: 'How it works' },
      { id: 'make', label: 'Make' },
      { id: 'test', label: 'Test it' },
    ]);
    expect(viewTrail(OVERVIEW, 'top')).toEqual([{ id: 'top', label: 'How it works' }]);
  });
});

describe('viewList', () => {
  test("lists every view depth first, with its depth, card count and its opener's line", () => {
    expect(viewList(OVERVIEW)).toEqual([
      { id: 'top', label: 'How it works', depth: 0, cards: 3, line: undefined },
      { id: 'make', label: 'Make', depth: 1, cards: 2, line: 'What Make does.' },
      { id: 'test', label: 'Test it', depth: 2, cards: 1, line: 'What Test it does.' },
      { id: 'check', label: 'Check', depth: 1, cards: 1, line: 'What Check does.' },
    ]);
  });
});

describe('openView', () => {
  test('the root without ?view=, the view it names, and the root for an unknown one, saying so', () => {
    expect(openView(OVERVIEW, null)).toEqual({ id: 'top', unknown: undefined });
    expect(openView(OVERVIEW, 'make')).toEqual({ id: 'make', unknown: undefined });
    expect(openView(OVERVIEW, 'gone')).toEqual({ id: 'top', unknown: 'gone' });
  });
});
