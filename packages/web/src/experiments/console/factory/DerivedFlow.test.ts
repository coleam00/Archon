import { expect, test } from 'bun:test';
import type { ItemRead, PackGraph } from '../skills/items';
import { flowCounts } from './DerivedFlow';

const columns = [
  { name: 'Make', stages: ['plan', 'build'] },
  { name: 'Check', stages: ['check'] },
];

/** An item standing at a run of `workflow`, as far as the overview reads one. */
function item(workflow: string, rest: { asked?: boolean } = {}): ItemRead {
  return {
    standing: { runId: 'r1', state: rest.asked ? 'waiting' : 'running' },
    runs: [
      {
        id: 'r1',
        pack: { key: 'flow', workflow },
      },
    ],
    questions: rest.asked ? [{ kind: 'attention' }] : [],
  } as unknown as ItemRead;
}

test('each column counts the items standing at its stages and the ones that wait on the operator', () => {
  // A run from an older build recorded no workflow name: the graph stage's name finds it.
  const older = {
    ...item('check'),
    runs: [{ id: 'r1', workflow: 'acme/flow:check', pack: null }],
  } as unknown as ItemRead;
  const counts = flowCounts(
    columns,
    [item('plan'), item('build', { asked: true }), item('check'), older],
    [{ name: 'acme/flow:check', workflow: 'check' }] as PackGraph['stages']
  );
  expect(counts.map(column => [column.name, column.count, column.needYou])).toEqual([
    ['Make', 2, 1],
    ['Check', 2, 0],
  ]);
});
