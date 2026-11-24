import { describe, expect, test } from 'bun:test';
import { askItem } from '../../lib/needs-you.test-fixtures';
import type { FactoryItem } from '../../skills/factory';
import { boardModel, columnChips, filterBoard, type BoardModel } from './board';
import {
  delivering,
  endedAt,
  endLastRun,
  FIXTURE_NOW,
  idleInPlan,
  ITEM_114,
  keepRuns,
  lastRunAs,
  needsShaping,
  PAGE,
  parkedByTriage,
  progressOf,
  queuedStart,
  readyWithMerge,
  realItem,
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
    expect(
      board.setAside.map(({ kind, why, detail, since }) => ({ kind, why, detail, since }))
    ).toEqual([
      {
        kind: 'parked',
        why: 'Parked by triage',
        detail: 'Worth doing; measure it first.',
        since: parked.runs[0]?.completedAt ?? null,
      },
    ]);
    expect(columnKeys(board)).toEqual([]);
  });

  test('an idle item that never proposed a change, past the line and not before or on it', () => {
    const past = model([idleInPlan('i', OLD)]);
    expect(past.setAside.map(entry => [entry.placed.card.key, entry.kind, entry.why])).toEqual([
      ['i', 'idle', 'No change was proposed'],
    ]);
    expect(columnKeys(past)).toEqual([]);
    for (const at of [before(3 * DAY - MINUTE), before(3 * DAY)]) {
      const board = model([idleInPlan('i', at)]);
      expect(asideKeys(board)).toEqual([]);
      expect(columnKeys(board)).toEqual(['i']);
    }
  });

  test('#114 as read: deliver ended ask, the ask answered, no pull request; set aside once 3 days pass', () => {
    // Its last run ended 2026-11-20 21:38:49 UTC, so the line falls at 2026-11-23 21:38:49 UTC.
    const at = (iso: string): BoardModel =>
      boardModel(VIEW, 'cb-1', [ITEM_114], new Map(), new Date(iso));
    for (const iso of ['2026-11-23T19:50:22Z', '2026-11-23T21:38:49Z']) {
      const before = at(iso);
      expect(before.setAside).toEqual([]);
      expect(
        before.columns.flatMap(column =>
          column.cards.map(placed => [placed.card.key, placed.card.stage, placed.card.pill])
        )
      ).toEqual([['114', 'Build', 'waiting']]);
    }
    for (const iso of ['2026-11-23T21:38:50Z', '2026-12-02T15:00:00Z']) {
      const after = at(iso);
      expect(columnKeys(after)).toEqual([]);
      expect(
        after.setAside.map(entry => [entry.placed.card.key, entry.kind, entry.why, entry.since])
      ).toEqual([['114', 'idle', 'Its merge state could not be read', '2026-11-20T21:38:49.000Z']]);
    }
  });

  test('an idle item whose change could not be read is set aside; one with an open change is not', () => {
    const unknown = endedAt(readyWithMerge('u', 'unknown'), OLD);
    const open = endedAt(readyWithMerge('o', false), OLD);
    const board = model([unknown, open]);
    expect(board.setAside.map(entry => [entry.placed.card.key, entry.why])).toEqual([
      ['u', 'Its merge state could not be read'],
    ]);
    expect(columnKeys(board)).toEqual(['o']);
  });

  test('an idle failed item that never proposed a change is set aside, saying it failed', () => {
    const failed = endedAt(endLastRun(keepRuns(realItem('6'), 2), 'failed', null), OLD);
    const [entry, ...rest] = model([
      { ...failed, progress: { ...progressOf(failed), change: null } },
    ]).setAside;
    expect(rest).toEqual([]);
    expect(entry?.kind).toBe('idle');
    expect(entry?.why).toContain('failed');
  });

  test('an item with an open ask, or waiting on you, is never set aside, parked or old', () => {
    const asking = (item: FactoryItem): FactoryItem => ({ ...item, questions: [askItem()] });
    const board = model([
      asking(parkedByTriage('p')),
      asking(idleInPlan('i', OLD)),
      endedAt(needsShaping('s', ['Which?']), OLD),
    ]);
    expect(board.setAside).toEqual([]);
    expect(columnKeys(board).sort()).toEqual(['i', 'p', 's']);
  });

  test('a new run, or a start waiting for it, brings it back to its column at once', () => {
    const idle = idleInPlan('i', OLD);
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
      running,
      { ...idle, queued: [queuedStart()] },
      { ...parkedByTriage('p'), queued: [queuedStart()] },
    ]);
    expect(board.setAside).toEqual([]);
    expect(columnKeys(board).sort()).toEqual(['8', 'i', 'p']);
    // The same item once its run ended, nothing run since: set aside again.
    expect(asideKeys(model([idle]))).toEqual(['i']);
  });

  test('a parked item with a run not yet ended (pending or paused) stays in its column', () => {
    const parked = parkedByTriage('p');
    const [triage] = parked.runs;
    if (triage === undefined) throw new Error('the parked fixture has its triage run');
    // A start the engine took but has not run: placement reads no running run.
    const next = { ...triage, id: 'next', status: 'pending' as const, completedAt: null };
    const pending = { ...parked, runs: [...parked.runs, next] };
    expect(model([pending]).setAside).toEqual([]);
    expect(columnKeys(model([pending]))).toEqual(['p']);
  });

  test('an item with no run, or one not yet ended, has no last run to count from', () => {
    const fresh = idleInPlan('f', OLD);
    const unfinished = idleInPlan('u', OLD);
    const board = model([
      { ...fresh, runs: [] },
      { ...unfinished, runs: unfinished.runs.map(run => ({ ...run, completedAt: null })) },
    ]);
    expect(board.setAside).toEqual([]);
  });

  test('an ending is set aside with its label; an item no column holds keeps its own row', () => {
    const view = structuredClone(VIEW);
    view.columns = view.columns?.filter(column => column.id !== 'intake');
    const board = boardModel(
      view,
      'cb-1',
      [lastRunAs('d', 'close', 'dropped'), lastRunAs('w', 'triage', 'park')],
      new Map(),
      FIXTURE_NOW
    );
    expect(board.setAside.map(entry => [entry.placed.card.key, entry.kind, entry.why])).toEqual([
      ['d', 'ended', 'Dropped by you'],
    ]);
    // Parked without the server's parked words is a Waiting card in Triage, which no column holds.
    expect(board.unplaced.map(placed => placed.card.key)).toEqual(['w']);
  });

  test('newest first, by when the last run ended', () => {
    const board = model([idleInPlan('older', before(15 * DAY)), idleInPlan('newer', OLD)]);
    expect(asideKeys(board)).toEqual(['newer', 'older']);
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

  test('the filter box narrows them; a number that narrows the board hides them', () => {
    expect(asideKeys(filterBoard(board, 'i-aside', undefined, FIXTURE_NOW))).toEqual(['i-aside']);
    expect(filterBoard(board, '', 'in-flight', FIXTURE_NOW).setAside).toEqual([]);
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
