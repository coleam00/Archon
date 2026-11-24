import { expect, test } from 'bun:test';
import type { FactoryItem } from '../../skills/factory';
import { delivering, progressOf, readyWithMerge, realItem } from './board.test-fixtures';
import { awaitingMerge, awaitingMergeKeys, mergePending, stageCountPending } from './merge-pending';

/** Item 6 keyed `key` with no change proposed, or with its progress unread. */
const noChange = (key: string): FactoryItem => {
  const item = { ...realItem('6'), item: { ...realItem('6').item, key } };
  item.progress = { ...progressOf(item), change: null };
  return item;
};
const unread = (key: string): FactoryItem => ({
  ...realItem('6'),
  item: { ...realItem('6').item, key },
  progress: null,
});
const runningWithPending = (): FactoryItem => {
  const item = delivering('build');
  item.progress = {
    ...progressOf(item),
    change: { url: 'https://example.test/pull/1', merged: 'pending', mergedAt: null, number: 1 },
  };
  return item;
};

// Each row: the item, whether its merge state is still being asked (mergePending), and whether
// it waits on a merge the watch asks about (awaitingMerge).
test.each([
  ['idle, merge state pending', readyWithMerge('d', 'pending'), true, false],
  ['running: placed by its run', runningWithPending(), false, false],
  ['merged', readyWithMerge('a', true), false, false],
  ['not merged', readyWithMerge('b', false), false, true],
  ['lookup failed', readyWithMerge('c', 'unknown'), false, true],
  ['no change', noChange('e'), false, false],
  ['progress unread', unread('f'), false, false],
] as const)('%s', (_name, item, pending, awaiting) => {
  expect(mergePending(item)).toBe(pending);
  expect(awaitingMerge(item)).toBe(awaiting);
});

test('the waiting keys, in order', () => {
  const items = [
    readyWithMerge('a', true),
    readyWithMerge('b', false),
    readyWithMerge('c', 'unknown'),
  ];
  expect(awaitingMergeKeys(items)).toEqual(['b', 'c']);
});

test('a stage holding a waiting item, and the landed stage while any item waits, count pending', () => {
  const pending = readyWithMerge('p', 'pending');
  expect(stageCountPending('ready', 'landed', [pending], true)).toBe(true);
  expect(stageCountPending('landed', 'landed', [], true)).toBe(true);
  expect(stageCountPending('build', 'landed', [realItem('6')], true)).toBe(false);
  expect(stageCountPending('landed', 'landed', [], false)).toBe(false);
});
