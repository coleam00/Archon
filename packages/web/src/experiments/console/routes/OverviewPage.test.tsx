import { expect, test } from 'bun:test';
import type { ItemRead } from '../skills/items';
import { flowCounts, todayCounts } from './OverviewPage';

const columns = [
  { name: 'Make', stages: ['plan', 'build'] },
  { name: 'Check', stages: ['check'] },
];

/** An item standing at a run of `workflow`, as far as the overview reads one. */
function item(
  workflow: string,
  rest: { asked?: boolean; startedAt?: string; mergedAt?: string } = {}
): ItemRead {
  return {
    standing: { runId: 'r1', state: rest.asked ? 'waiting' : 'running' },
    runs: [
      {
        id: 'r1',
        pack: { key: 'flow', workflow },
        startedAt: rest.startedAt ?? '2026-11-01T00:00:00Z',
      },
    ],
    questions: rest.asked ? [{ kind: 'attention' }] : [],
    merged: rest.mergedAt === undefined ? null : { at: rest.mergedAt },
  } as unknown as ItemRead;
}

test('each column counts the items standing at its stages and the ones that wait on the operator', () => {
  const counts = flowCounts(columns, [item('plan'), item('build', { asked: true }), item('check')]);
  expect(counts.map(column => [column.name, column.count, column.needYou])).toEqual([
    ['Make', 2, 1],
    ['Check', 1, 0],
  ]);
});

test('today counts the items first started today and the ones whose change merged today', () => {
  const since = '2026-11-24T00:00:00Z';
  const counts = todayCounts(
    {
      items: [
        item('plan', { startedAt: '2026-11-24T08:00:00Z' }),
        item('check', { startedAt: '2026-11-20T08:00:00Z', mergedAt: '2026-11-24T09:00:00Z' }),
        item('check', { startedAt: '2026-11-20T08:00:00Z', mergedAt: '2026-11-23T09:00:00Z' }),
      ],
    },
    since
  );
  expect(counts).toEqual({ entered: 1, landed: 1 });
});
