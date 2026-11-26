import { expect, test } from 'bun:test';
import type { ItemRead } from '../../skills/items';
import { packBoard, projectSetAside } from './board-numbers';

type Link = ItemRead['links'][number];

/** An item of pack `flow` standing `state`, with runs started at `starts` (SQLite form, no Z). */
function item(
  key: string,
  state: ItemRead['standing']['state'],
  rest: { starts?: string[]; mergedAt?: string; links?: Link[]; status?: string } = {}
): ItemRead {
  const starts = rest.starts ?? ['2026-11-20 10:00:00'];
  return {
    item: { id: key, projectKey: 'p', key, title: key },
    standing: { runId: starts.length === 0 ? null : 'r0', state, pack: 'flow' },
    runs: starts.map((startedAt, i) => ({
      id: `r${String(i)}`,
      startedAt,
      completedAt: startedAt,
      status: rest.status ?? 'completed',
      outcome: null,
    })),
    questions: [],
    links: rest.links ?? [],
    merged: rest.mergedAt === undefined ? null : { at: rest.mergedAt },
  } as unknown as ItemRead;
}

const hasPart: Link = {
  kind: 'part_of',
  direction: 'incoming',
  ended: null,
} as unknown as Link;

const NOW = new Date(2026, 10, 24, 12, 0);
/** `days` local days before NOW's day, at 09:00 local, as an ISO instant. */
const daysAgo = (days: number): string => new Date(2026, 10, 24 - days, 9, 0).toISOString();

test('the median runs from the earliest run start to the merge, over the merged items', () => {
  const merged = (key: string, starts: string[], mergedAt: string): ItemRead =>
    item(key, 'done', { starts, mergedAt });
  const odd = packBoard(
    [
      // Its later-listed run started first: 2 h, not 1 h.
      merged('a', ['2026-11-20 10:00:00', '2026-11-20 09:00:00'], '2026-11-20T11:00:00Z'),
      merged('b', ['2026-11-20 10:00:00'], '2026-11-20T10:30:00Z'),
      merged('c', ['2026-11-20 10:00:00'], '2026-11-20T14:00:00Z'),
      // No run: no time to merged.
      merged('d', [], '2026-11-20T10:00:00Z'),
    ],
    'flow',
    NOW
  );
  expect(odd.numbers.medianToMergedMs).toBe(2 * 3600_000);
  const even = packBoard(
    [
      merged('a', ['2026-11-20 10:00:00'], '2026-11-20T11:00:00Z'),
      merged('b', ['2026-11-20 10:00:00'], '2026-11-20T13:00:00Z'),
    ],
    'flow',
    NOW
  );
  expect(even.numbers.medianToMergedMs).toBe(2 * 3600_000);
  expect(packBoard([], 'flow', NOW).numbers.medianToMergedMs).toBeNull();
});

test('Merged lists the last seven local days, newest first; today and the total count apart', () => {
  const board = packBoard(
    [
      item('old', 'done', { mergedAt: daysAgo(7) }),
      item('edge', 'done', { mergedAt: daysAgo(6) }),
      item('today', 'done', { mergedAt: daysAgo(0) }),
      item('moving', 'running'),
    ],
    'flow',
    NOW
  );
  expect(board.merged.recent.map(read => read.item.key)).toEqual(['today', 'edge']);
  expect(board.merged.earlier.map(read => read.item.key)).toEqual(['old']);
  expect(board.numbers).toMatchObject({
    inFlight: 1,
    mergedToday: 1,
    mergedRecent: 2,
    merged: 3,
    total: 4,
  });
});

test('a work order counts only on a stage or by its own merge; set-aside items are not on the board', () => {
  const board = packBoard(
    [
      // Done through its parts, with no merge of its own: only in the work-orders strip.
      item('order', 'done', { links: [hasPart] }),
      // #157's shape: an order whose own change merged is a merged item like any other.
      item('merged-order', 'done', { links: [hasPart], mergedAt: daysAgo(2) }),
      item('running-order', 'running', { links: [hasPart] }),
      item('dropped', 'done'),
      item('cancelled', 'resting', { status: 'cancelled' }),
      item('failed', 'failed'),
      item('merged', 'done', { mergedAt: daysAgo(1) }),
    ],
    'flow',
    NOW
  );
  expect(board.onBoard.map(read => read.item.key)).toEqual([
    'running-order',
    'failed',
    'merged',
    'merged-order',
  ]);
  expect(board.merged.recent.map(read => read.item.key)).toEqual(['merged', 'merged-order']);
  expect(board.numbers).toMatchObject({ merged: 2, total: 4 });
});

test('an item ended without merging or at rest is set aside, with why; a failed one or an order is not', () => {
  const aside = projectSetAside([
    item('order', 'resting', { links: [hasPart] }),
    item('failed', 'failed'),
    item('cancelled', 'resting', { status: 'cancelled', starts: ['2026-11-21 10:00:00'] }),
    item('no-outcome', 'resting'),
    item('dropped', 'done', { starts: ['2026-11-22 10:00:00'] }),
  ]);
  expect(aside.map(entry => [entry.read.item.key, entry.why])).toEqual([
    // `howItEnded`: the run's outcome, else Done.
    ['dropped', 'Done'],
    ['cancelled', 'Cancelled'],
    ['no-outcome', 'Ended with no outcome'],
  ]);
});

test('with a placement, a moving item at no stage is set aside and on no count', () => {
  const placed = item('placed', 'running');
  const lost = item('lost', 'waiting');
  const place = (read: ItemRead): string | undefined =>
    read.item.key === 'placed' ? 'build' : undefined;
  const board = packBoard([placed, lost], 'flow', NOW, place);
  expect(board.moving.map(read => read.item.key)).toEqual(['placed']);
  expect(board.unplaced.map(read => read.item.key)).toEqual(['lost']);
  expect(board.onBoard.map(read => read.item.key)).toEqual(['placed']);
  expect(board.numbers.inFlight).toBe(1);
  expect(board.numbers.total).toBe(1);
  // Until the pack is read there is no placement, and every moving item counts.
  expect(packBoard([placed, lost], 'flow', NOW).moving.length).toBe(2);
  // Set aside says why, since its run started.
  expect(projectSetAside([placed, lost], [{ read: lost, why: 'On no stage' }])).toEqual([
    { read: lost, why: 'On no stage', since: '2026-11-20 10:00:00' },
  ]);
});
