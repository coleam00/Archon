import { describe, expect, test } from 'bun:test';
import { askItem } from '../../lib/needs-you.test-fixtures';
import type { FactoryItem } from '../../skills/factory';
import { boardModel, columnChips, type BoardModel } from './board';
import {
  delivering,
  endedAt,
  FIXTURE_NOW,
  idleInPlan,
  ITEM_114,
  needsShaping,
  PAGE,
  parkedByTriage,
  progressOf,
  queuedStart,
  readyWithMerge,
  VIEW,
} from './board.test-fixtures';
import { factoryNumbers } from './numbers';
import { tableRows } from './board-table';
import { workOrders } from './work-orders';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The time `ms` before `FIXTURE_NOW`, as the engine stamps a run's end. */
const before = (ms: number): string => new Date(FIXTURE_NOW.getTime() - ms).toISOString();
// The item's line is 3 days, written out rather than read from `SET_ASIDE_IDLE_MS`, so a
// change to the constant fails here.
const OLD = before(3 * DAY + MINUTE);

const model = (items: FactoryItem[]): BoardModel =>
  boardModel(VIEW, 'cb-1', items, new Map(), FIXTURE_NOW);
const columnKeys = (board: BoardModel): string[] =>
  board.columns.flatMap(column => column.cards.map(placed => placed.card.key));
const asideKeys = (board: BoardModel): string[] =>
  board.setAside.map(entry => entry.placed.card.key);

describe('which items the board sets aside', () => {
  test('a parked item, in its parked words, with when its last run ended', () => {
    const parked = parkedByTriage();
    const board = model([parked]);
    expect(board.setAside[0]).toMatchObject({
      kind: 'parked',
      why: 'Parked by triage',
      detail: 'Worth doing; measure it first.',
      since: parked.runs[0]?.completedAt,
    });
    expect(columnKeys(board)).toEqual([]);
  });

  test('an idle item that never proposed a change, past the line and not before or on it', () => {
    const past = model([idleInPlan('i', OLD)]);
    expect(past.setAside.map(entry => [entry.placed.card.key, entry.kind, entry.why])).toEqual([
      ['i', 'idle', 'No change was proposed'],
    ]);
    expect(columnKeys(past)).toEqual([]);
    // On the line is not past it.
    expect(columnKeys(model([idleInPlan('i', before(3 * DAY))]))).toEqual(['i']);
  });

  test('#114 as read: deliver ended ask, the ask answered, no pull request; set aside once 3 days pass', () => {
    // Its last run ended 2026-11-20 21:38:49 UTC, so the line falls at 2026-11-23 21:38:49 UTC.
    const at = (iso: string): BoardModel =>
      boardModel(VIEW, 'cb-1', [ITEM_114], new Map(), new Date(iso));
    const onTheLine = at('2026-11-23T21:38:49Z');
    expect(onTheLine.setAside).toEqual([]);
    expect(onTheLine.columns.flatMap(c => c.cards.map(p => [p.card.key, p.card.stage]))).toEqual([
      ['114', 'Build'],
    ]);
    const after = at('2026-11-23T21:38:50Z');
    expect(columnKeys(after)).toEqual([]);
    expect(after.setAside.map(entry => [entry.placed.card.key, entry.why, entry.since])).toEqual([
      ['114', 'Its merge state could not be read', '2026-11-20T21:38:49.000Z'],
    ]);
  });

  test('an idle item whose change could not be read is set aside; one with an open change is not', () => {
    const board = model([
      endedAt(readyWithMerge('u', 'unknown'), OLD),
      endedAt(readyWithMerge('o', false), OLD),
    ]);
    expect(asideKeys(board)).toEqual(['u']);
    expect(columnKeys(board)).toEqual(['o']);
  });

  test('never set aside: an open ask, waiting on you, a run working it, a start waiting', () => {
    const asking = (item: FactoryItem): FactoryItem => ({ ...item, questions: [askItem()] });
    // Item 8 with no change and its ended runs old: only the run working it now keeps it.
    const working = delivering('build__build');
    const running: FactoryItem = {
      ...working,
      runs: working.runs.map(run =>
        run.completedAt === null ? run : { ...run, completedAt: OLD }
      ),
      progress: { ...progressOf(working), change: null },
    };
    const board = model([
      asking(parkedByTriage('p')),
      asking(idleInPlan('i', OLD)),
      endedAt(needsShaping('s', ['Which?']), OLD),
      running,
      { ...idleInPlan('q', OLD), queued: [queuedStart()] },
    ]);
    expect(board.setAside).toEqual([]);
    expect(columnKeys(board).sort()).toEqual(['8', 'i', 'p', 'q', 's']);
  });
});

describe('what counts a set-aside item', () => {
  const inOrder = (item: FactoryItem): FactoryItem => ({
    ...item,
    progress: { ...progressOf(item), partOf: 'o' },
  });
  const items = [
    ...PAGE.items,
    inOrder(parkedByTriage('p-aside')),
    inOrder(idleInPlan('i-aside', OLD)),
    idleInPlan('y', before(MINUTE)),
  ];
  const board = model(items);

  test('no column header or chip, not In flight and not M', () => {
    expect(asideKeys(board).sort()).toEqual(['i-aside', 'p-aside']);
    const onBoard = board.columns.flatMap(column => column.cards);
    expect(onBoard.map(placed => placed.card.key)).toContain('y');
    for (const column of board.columns)
      expect(columnChips(column.cards).find(chip => chip.pill === 'parked')).toBeUndefined();
    const without = factoryNumbers(model(PAGE.items), FIXTURE_NOW);
    const numbers = factoryNumbers(board, FIXTURE_NOW);
    // Only `y`, still in its column, adds to In flight and M.
    expect(numbers).toMatchObject({ inFlight: without.inFlight + 1, total: without.total + 1 });
  });

  test('the Table follows the columns: set-aside items are no rows, unplaced ones are', () => {
    const view = structuredClone(VIEW);
    view.columns = view.columns?.filter(column => column.id !== 'checks-review');
    const withUnplaced = boardModel(
      view,
      'cb-1',
      [...items, delivering('rounds.review__review')],
      new Map(),
      FIXTURE_NOW
    );
    const rows = tableRows(withUnplaced).map(row => [row.placed.card.key, row.column]);
    expect(rows.map(([key]) => key)).not.toContain('p-aside');
    expect(rows.map(([key]) => key)).not.toContain('i-aside');
    expect(rows).toContainEqual(['8', 'Position unknown']);
  });

  test('a set-aside member of a work order still says where it is', () => {
    const [found] = workOrders(items, board, {});
    expect(found?.members.map(member => [member.key, member.where])).toEqual([
      ['p-aside', 'Parked by triage'],
      ['i-aside', 'Set aside'],
    ]);
  });
});
