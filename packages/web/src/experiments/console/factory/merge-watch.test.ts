import { afterEach, expect, test } from 'bun:test';
import type { FactoryItem, FactoryProgress } from '../skills/factory';
import { get, invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { readyWithMerge } from './lib/board.test-fixtures';
import type { FactoryItemsRead } from './lib/factory-items-read';
import { cancelMergeWatches, watchMerges, type MergeWatchDeps } from './merge-watch';

afterEach(() => {
  cancelMergeWatches();
  invalidate('factory-items');
});

const turn = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/** Enough turns for several ticks at a zero delay to ask and settle. */
const ticks = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await turn(1);
};

type Merged = NonNullable<NonNullable<FactoryItem['progress']>['change']>['merged'];

/** A tab whose visibility the test sets, and announces like a browser does. */
function fakeDoc(): NonNullable<MergeWatchDeps['doc']> & { show(): void; hide(): void } {
  const target = new EventTarget();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    show() {
      doc.visibilityState = 'visible';
      target.dispatchEvent(new Event('visibilitychange'));
    },
    hide() {
      doc.visibilityState = 'hidden';
      target.dispatchEvent(new Event('visibilitychange'));
    },
  };
  return doc as never;
}

/**
 * A progress read that records every request's keys and answers each key from `state`
 * (merged `false` for a key it does not name), or rejects while `fail` is set.
 */
function forge(state: Record<string, Merged> = {}) {
  const asked: string[][] = [];
  const fake = {
    asked,
    fail: false,
    state,
    getProgress: (async ({ keys }: { keys?: string[] | string }) => {
      const list = Array.isArray(keys) ? keys : [keys ?? ''];
      asked.push(list);
      if (fake.fail) throw new Error('the forge is down');
      const progress: FactoryProgress['progress'] = {};
      for (const key of list) progress[key] = readyWithMerge(key, state[key] ?? false).progress;
      return { pack: 'p', progress, members: {} };
    }) as MergeWatchDeps['getProgress'],
  };
  return fake;
}

const read = (projectId: string): FactoryItemsRead =>
  get(K.factoryItems(projectId)) as FactoryItemsRead;
const seed = (projectId: string, items: FactoryItem[]): void =>
  set(K.factoryItems(projectId), { items, members: {} });

test('an unmerged change starts the watch, which asks only about the waiting keys', async () => {
  seed('cb-keys', [readyWithMerge('a', true), readyWithMerge('b', false)]);
  const host = forge();
  const release = watchMerges('cb-keys', { getProgress: host.getProgress, delayMs: 0 });
  await ticks(1);
  release();
  expect(host.asked[0]).toEqual(['b']);
});

test('more than a page of waiting keys asks a page at a time', async () => {
  seed(
    'cb-pages',
    Array.from({ length: 101 }, (_, i) => readyWithMerge(`k${i.toString()}`, false))
  );
  const host = forge();
  const release = watchMerges('cb-pages', { getProgress: host.getProgress, delayMs: 0 });
  await ticks(1);
  release();
  expect(host.asked.slice(0, 2).map(keys => keys.length)).toEqual([100, 1]);
});

test('once the forge says merged, the item is merged and nothing more is asked', async () => {
  seed('cb-merge', [readyWithMerge('b', false)]);
  const host = forge({ b: true });
  const release = watchMerges('cb-merge', { getProgress: host.getProgress, delayMs: 0 });
  try {
    await ticks();
    expect(read('cb-merge').items[0]?.progress?.change?.merged).toBe(true);
    expect(host.asked).toEqual([['b']]);
  } finally {
    release();
  }
});

test('an item that leaves the board, or the last release, stops the asking', async () => {
  seed('cb-leave', [readyWithMerge('b', false)]);
  const host = forge();
  const release = watchMerges('cb-leave', { getProgress: host.getProgress, delayMs: 0 });
  await ticks(2);
  expect(host.asked.length).toBeGreaterThan(0);
  seed('cb-leave', [readyWithMerge('a', true)]);
  await ticks(1);
  const afterLeaving = host.asked.length;
  await ticks();
  expect(host.asked.length).toBe(afterLeaving);

  seed('cb-leave', [readyWithMerge('b', false)]);
  release();
  await ticks();
  expect(host.asked.length).toBe(afterLeaving);
});

test('a hidden tab asks nothing, and asks again when it shows', async () => {
  seed('cb-hidden', [readyWithMerge('b', false)]);
  const host = forge();
  const doc = fakeDoc();
  doc.hide();
  const release = watchMerges('cb-hidden', { getProgress: host.getProgress, delayMs: 0, doc });
  try {
    await ticks();
    expect(host.asked).toEqual([]);
    doc.show();
    await turn();
    expect(host.asked).toEqual([['b']]);
  } finally {
    release();
  }
});

test('an open item page takes the answer too, so its header agrees with the board', async () => {
  const item = readyWithMerge('b', false);
  seed('cb-detail', [item]);
  const detailKey = K.factoryItem('cb-detail', 'b');
  set(detailKey, { pack: 'p', item, runs: [] });
  const host = forge({ b: true });
  const release = watchMerges('cb-detail', { getProgress: host.getProgress, delayMs: 0 });
  try {
    await ticks(1);
    const detail = get(detailKey) as { item: FactoryItem };
    expect(detail.item.progress?.change?.merged).toBe(true);
  } finally {
    release();
    invalidate(detailKey);
  }
});

test('a whole-board read that lands during the ask wins', async () => {
  seed('cb-stale', [readyWithMerge('b', false)]);
  let answer: (() => void) | undefined;
  const host = forge({ b: true });
  const held: MergeWatchDeps['getProgress'] = (query, init) =>
    new Promise(resolve => {
      answer = () => void host.getProgress(query, init).then(resolve);
    });
  const release = watchMerges('cb-stale', { getProgress: held, delayMs: 0 });
  try {
    await ticks(1);
    const newer = { items: [readyWithMerge('b', false), readyWithMerge('z', false)], members: {} };
    set(K.factoryItems('cb-stale'), newer);
    answer?.();
    await ticks(1);
    expect(read('cb-stale')).toBe(newer);
  } finally {
    release();
  }
});

test('a failed ask keeps the board as it was and asks again next time', async () => {
  seed('cb-fail', [readyWithMerge('b', false)]);
  const before = read('cb-fail');
  const host = forge({ b: true });
  host.fail = true;
  const warn = console.warn;
  console.warn = () => undefined;
  const release = watchMerges('cb-fail', { getProgress: host.getProgress, delayMs: 0 });
  try {
    await ticks(3);
    expect(host.asked.length).toBeGreaterThan(1);
    expect(read('cb-fail')).toBe(before);
    host.fail = false;
    await ticks();
    expect(read('cb-fail').items[0]?.progress?.change?.merged).toBe(true);
  } finally {
    console.warn = warn;
    release();
  }
});

test('two readers share one watch: one ask per interval, until both release', async () => {
  seed('cb-two', [readyWithMerge('b', false)]);
  const host = forge();
  const deps = { getProgress: host.getProgress, delayMs: 20 };
  const first = watchMerges('cb-two', deps);
  const second = watchMerges('cb-two', deps);
  await turn(30);
  expect(host.asked.length).toBe(1);
  // The reader that came last leaves first: the watch is shared, so the other keeps it.
  second();
  await turn(20);
  expect(host.asked.length).toBe(2);
  first();
  await turn(40);
  expect(host.asked.length).toBe(2);
});
