import { expect, test } from 'bun:test';
import type { ItemRead, PackGraph } from '../skills/items';
import { flowCounts, stageCounts } from './DerivedFlow';
import { asksOn, itemOn } from './items.test-fixtures';

const columns = [
  { name: 'Make', stages: ['plan', 'build'] },
  { name: 'Check', stages: ['check'] },
];
const stages = [{ name: 'acme/flow:check', workflow: 'check' }] as PackGraph['stages'];

// A run from an older build recorded no workflow name: the graph stage's name finds it.
const older: ItemRead = (() => {
  const read = itemOn('o1', 'check', 'running');
  const [run] = read.runs;
  return {
    ...read,
    runs: run === undefined ? [] : [{ ...run, workflow: 'acme/flow:check', pack: null }],
  };
})();
const waitingAsked = itemOn('a', 'build', 'waiting');
const waitingQuestion = itemOn('b', 'build', 'waiting', true);
const runningAsked = itemOn('c', 'plan', 'running');
const ITEMS = [runningAsked, waitingAsked, waitingQuestion, itemOn('d', 'check', 'running'), older];
// Open asks on a waiting and a running item; `waitingQuestion` has a question in its read, no ask.
const ASKS = asksOn([waitingAsked, runningAsked]);

test("each column counts the items standing at its stages and those with open asks, by the cards' rule", () => {
  expect(
    flowCounts(columns, ITEMS, stages, ASKS).map(column => [
      column.name,
      column.count,
      column.needYou,
    ])
  ).toEqual([
    ['Make', 3, 2],
    ['Check', 2, 0],
  ]);
});

test('each stage counts its items with open asks, and none is counted while the asks are read', () => {
  const counted = stageCounts(ITEMS, stages, ASKS);
  expect(counted.get('build')).toEqual({ count: 2, needYou: 1 });
  expect(counted.get('plan')).toEqual({ count: 1, needYou: 1 });
  expect(counted.get('check')).toEqual({ count: 2, needYou: 0 });
  expect(stageCounts(ITEMS, stages, 'reading').get('build')).toEqual({ count: 2, needYou: null });
  expect(flowCounts(columns, ITEMS, stages, 'failed').map(column => column.needYou)).toEqual([
    null,
    null,
  ]);
});
