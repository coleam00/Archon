import { expect, test } from 'bun:test';
import type { ItemRead, PackGraph } from '../skills/items';
import { flowCounts, sendsBack, todayCounts } from './OverviewPage';

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

test('a column sends work back when an outcome of its stage starts a stage of an earlier column', () => {
  const stage = (name: string) => ({ name: `flow/${name}`, workflow: name });
  const arrow = (from: object, to: string) => ({ from, to: `flow/${to}` });
  const graph = {
    stages: ['plan', 'build', 'check'].map(stage),
    arrows: [
      arrow({ stage: 'flow/plan', outcome: 'planned' }, 'build'),
      arrow({ stage: 'flow/build', outcome: 'built' }, 'check'),
      arrow({ stage: 'flow/check', outcome: 'return' }, 'build'),
      arrow({ stage: 'flow/check', outcome: 'replan' }, 'plan'),
      // An answer is not the end of a run: it draws no arrow back.
      arrow({ stage: 'flow/check', settled: 'answered' }, 'plan'),
    ],
  } as unknown as Pick<PackGraph, 'arrows' | 'stages'>;
  expect(sendsBack(columns, graph)).toEqual([{ from: 'Check', to: 'Make' }]);
  expect(sendsBack(columns, { ...graph, arrows: graph.arrows.slice(0, 2) })).toEqual([]);
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
