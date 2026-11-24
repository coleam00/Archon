import { describe, expect, test } from 'bun:test';
import { askItem } from '../../lib/needs-you.test-fixtures';
import type { FactoryItem } from '../../skills/factory';
import { boardModel, filterBoard } from './board';
import {
  endLastRun,
  keepRuns,
  PAGE,
  progressOf,
  readyWithMerge,
  realItem,
  VIEW,
  FIXTURE_NOW,
} from './board.test-fixtures';
import { mergeUnsettled } from './merge-pending';
import { factoryNumbers } from './numbers';

/**
 * Every date here is built in local time, so the local-day boundary holds wherever the
 * tests run.
 */
const local = (day: number, hour: number, minute = 0): Date =>
  new Date(2026, 10, day, hour, minute);
const HOUR = 3_600_000;

/** A real landed item (7), its first run started at `start`, its change merged at `merged`. */
function landed(key: string, start: Date, merged: Date | null): FactoryItem {
  const item = realItem('7');
  const progress = progressOf(item);
  const change = progress.change;
  if (change === null) throw new Error('item 7 has a change in the fixture');
  item.item = { ...item.item, key };
  item.runs = item.runs.map((run, index) =>
    index === 0 ? { ...run, startedAt: start.toISOString() } : run
  );
  item.progress = {
    ...progress,
    change: { ...change, merged: true, mergedAt: merged?.toISOString() ?? null },
  };
  return item;
}

/** A copy of real item 6 (waiting in Build), keyed 6a, with an open ask. */
function asking(): FactoryItem {
  const item = realItem('6');
  item.item = { ...item.item, key: '6a' };
  item.questions = [askItem({ ref: 'ask:6a', item: { ...item.item } })];
  return item;
}

/** A copy of item 6, keyed 6t, closed by triage: its only run ended with an outcome placement does not take. */
function closedByTriage(): FactoryItem {
  const item = endLastRun(keepRuns(realItem('6'), 1), 'completed', 'close');
  return { ...item, item: { ...item.item, key: '6t' } };
}

const numbers = (items: FactoryItem[], now: Date) =>
  factoryNumbers(boardModel(VIEW, 'cb-1', items, new Map(), FIXTURE_NOW), now);

describe('the numbers strip', () => {
  test('in flight, landed and M over the real items; a triage-closed item in none', () => {
    const counts = numbers([...PAGE.items, asking(), closedByTriage()], local(17, 12));
    // 8, 5, 4, 6 and the asking copy of 6 are on the board outside Landed; 7, 2, 1 landed.
    // Item 3's merge state is unknown, so it counts only in M.
    expect(counts).toMatchObject({ inFlight: 5, landed: 3, total: 9, pending: false, unknown: 1 });
    // An item closed by triage is not in M, nor in flight.
    expect(numbers([realItem('5'), closedByTriage()], local(17, 12))).toMatchObject({
      inFlight: 1,
      total: 1,
    });
  });

  test('landed today follows the local day: 23:59 yesterday is not, 00:01 today is', () => {
    // bun test runs in UTC, where a local day and a UTC day are the same and the test could
    // not tell them apart. Only this test moves the zone: the median tests compare against
    // the fixture's real UTC timestamps. Restored to 'UTC', not deleted: without TZ, bun
    // falls back to the machine's zone.
    const zone = process.env.TZ;
    process.env.TZ = 'America/Chicago';
    try {
      const items = [
        landed('a', local(16, 20), local(16, 23, 59)),
        landed('b', local(16, 20), local(17, 0, 1)),
      ];
      expect(numbers(items, local(17, 9))).toMatchObject({ landedToday: 1, landed: 2 });
      expect(numbers(items, local(16, 23, 59)).landedToday).toBe(1);
    } finally {
      process.env.TZ = zone ?? 'UTC';
    }
  });

  test('median to land: odd and even counts, none when nothing landed', () => {
    const odd = [
      landed('a', local(17, 0), local(17, 1)),
      landed('b', local(17, 0), local(17, 3)),
      landed('c', local(17, 0), local(17, 8)),
    ];
    expect(numbers(odd, local(17, 12)).medianToLandMs).toBe(3 * HOUR);
    const even = [...odd, landed('d', local(17, 0), local(17, 10))];
    expect(numbers(even, local(17, 12)).medianToLandMs).toBe(5.5 * HOUR);
    expect(numbers([realItem('5')], local(17, 12)).medianToLandMs).toBeNull();
  });

  test('merged with no merge time: landed, but not today and not in the median', () => {
    const items = [landed('a', local(17, 0), null), landed('b', local(17, 0), local(17, 2))];
    expect(numbers(items, local(17, 12))).toMatchObject({
      landed: 2,
      landedToday: 1,
      medianToLandMs: 2 * HOUR,
    });
  });
});

test('an item whose merge state is not known is counted only in M, and the strip says so', () => {
  const now = local(17, 12);
  const settled = PAGE.items.filter(item => !mergeUnsettled(item));
  const known = numbers(settled, now);
  expect(known).toMatchObject({ pending: false, unknown: 0 });
  // Pending: a skeleton stands for it. Unknown: the strip says how many.
  expect(numbers([...settled, readyWithMerge('x', 'pending')], now)).toEqual({
    ...known,
    total: known.total + 1,
    pending: true,
  });
  expect(numbers([...settled, readyWithMerge('x', 'unknown')], now)).toEqual({
    ...known,
    total: known.total + 1,
    unknown: 1,
  });
});

test('the board under a number shows exactly the cards it counts, set-aside items hidden', () => {
  const now = local(17, 12);
  const model = boardModel(
    VIEW,
    'cb-1',
    [...PAGE.items, asking(), closedByTriage()],
    new Map(),
    FIXTURE_NOW
  );
  const keys = (query: string, show: 'landed' | 'needs-you') =>
    filterBoard(model, query, show, now)
      .columns.flatMap(column => column.cards.map(placed => placed.card.key))
      .sort();
  expect(keys('', 'landed')).toEqual(['1', '2', '7']);
  expect(model.setAside).not.toEqual([]);
  expect(filterBoard(model, '', 'landed', now).setAside).toEqual([]);
  expect(keys('', 'needs-you')).toEqual(['6a']);
  // It composes with the text filter.
  expect(keys('7', 'landed')).toEqual(['7']);
});
