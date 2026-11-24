import { afterAll, afterEach, beforeEach, expect, jest, setSystemTime, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import type { FactoryItem } from '../skills/factory';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { installDom } from '../test-dom.test-helpers';
import { FactoryNumbers } from './FactoryNumbers';
import { FIXTURE_NOW, PAGE, readyWithMerge, VIEW } from './lib/board.test-fixtures';
import { DISCOVERIES } from './lib/discoveries.test-fixtures';
import { cancelRereads, MERGE_REREAD_MS } from './merge-reread';
import { cancelMergeWatches, MERGE_WATCH_MS } from './merge-watch';

// The board sets aside items idle past a line counted from now, so the fixtures' items are read
// at the time they were copied. Before each test: `jest.useRealTimers()` puts the real clock back.
beforeEach(() => {
  setSystemTime(FIXTURE_NOW);
});
afterAll(() => {
  setSystemTime();
});

// A failed read lands after the first render, which static markup cannot reach.
const { mount: mountTree, settle } = await installDom();
const failing = globalThis.fetch;
/** The server is down unless a test serves something else. */
const serverDown = Object.assign(
  async (): Promise<Response> => {
    throw new Error('the server is down');
  },
  { preconnect: failing.preconnect }
);
globalThis.fetch = serverDown;

afterEach(() => {
  // A pending read schedules a re-read; it must not fire into the next test.
  cancelRereads();
  cancelMergeWatches();
  jest.useRealTimers();
  globalThis.fetch = serverDown;
  invalidate('factory-items');
});

/** The strip over `items` (warm from the cache, as the Overview reads it after the board), or cold. */
async function mount(projectId: string, items?: FactoryItem[], waiting: number | null = 2) {
  if (items !== undefined) set(K.factoryItems(projectId), { items, members: {} });
  const mounted = await mountTree(
    <MemoryRouter>
      <FactoryNumbers projectId={projectId} view={VIEW} waiting={waiting ?? undefined} />
    </MemoryRouter>
  );
  const tile = (label: string): string | null | undefined =>
    mounted.container.querySelector(`li[data-tile="${label}"]`)?.textContent;
  return { ...mounted, tile };
}

test('a failed first read says so, and never shows zeros', async () => {
  const { container, unmount } = await mount('cb-failing');
  for (let turn = 0; turn < 5 && container.querySelector('[role="alert"]') === null; turn++)
    await settle();
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('The numbers could not be loaded');
  expect(container.textContent).not.toContain('in flight');
  await unmount();
});

test('before the reads answer, every tile shows a skeleton figure, never a count or "…"', async () => {
  globalThis.fetch = Object.assign(() => new Promise<Response>(() => undefined), {
    preconnect: failing.preconnect,
  });
  const { container, unmount } = await mount('cb-unread', undefined, null);
  const tiles = [...container.querySelectorAll('[aria-label="Numbers"] li')];
  expect(tiles.map(li => li.textContent)).toEqual([
    'in flightLoading',
    'need youLoading',
    'merged todayLoading',
    'mergedLoading',
    'median to mergedLoading',
    'found by the factoryLoading',
  ]);
  expect(tiles.every(li => li.querySelector('[data-skeleton="figure"]') !== null)).toBe(true);
  expect(container.textContent).not.toContain('…');
  expect(container.querySelector('[aria-label="Numbers"]')?.textContent).not.toMatch(/\d/);
  await unmount();
});

test('while a merge state is pending, the counts it decides show what is known and a skeleton for the rest', async () => {
  // The cold-load wire value: the server still asking the host whether item p's change merged.
  const { container, tile, unmount } = await mount('cb-pending', [
    ...PAGE.items,
    readyWithMerge('p', 'pending'),
  ]);
  // The pending item is in M, and in no other count.
  expect(tile('merged')).toBe('merged3 of 9Checking which changes merged');
  expect(tile('in flight')).toBe('in flight4Checking which changes merged');
  for (const label of ['merged today', 'median to merged'])
    expect(tile(label)).toContain('Checking which changes merged');
  // The asks and waits that need you do not wait on a merge answer.
  expect(tile('need you')).toBe('need you2');
  // The answer arrives. Item 3's merge state could not be read: it stays out of the counts,
  // said in words and linking to the board narrowed to it, never as loading.
  await act(async () => set(K.factoryItems('cb-pending'), { items: PAGE.items, members: {} }));
  expect(tile('merged')).toBe('merged3 of 8');
  expect(container.textContent).not.toContain('Checking');
  const unknown = [...container.querySelectorAll('a')].find(link =>
    link.textContent?.includes('could not be read')
  );
  expect(unknown?.textContent).toBe('1 merge state could not be read');
  expect(unknown?.getAttribute('href')).toBe('/console/p/cb-pending/factory/board?show=unknown');
  await unmount();
});

test('a merge on the forge reaches the numbers on the watch interval, with no run event', async () => {
  const mergedAt = new Date().toISOString();
  const asked: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== '/api/factory/progress') throw new Error('the server is down');
      asked.push(url.searchParams.getAll('keys').join(','));
      const answer = readyWithMerge('w', true).progress;
      if (answer?.change) answer.change.mergedAt = mergedAt;
      return Response.json({ pack: 'p', progress: { w: answer }, members: {} });
    },
    { preconnect: failing.preconnect }
  );
  // The watch's interval is the only clock here: nothing invalidates the key.
  jest.useFakeTimers();
  setSystemTime(FIXTURE_NOW);
  const { tile, unmount } = await mount('cb-watch', [...PAGE.items, readyWithMerge('w', false)]);
  expect(tile('merged')).toBe('merged3 of 9');
  expect(tile('merged today')).toBe('merged today0');
  jest.advanceTimersByTime(MERGE_WATCH_MS - 1);
  expect(asked).toEqual([]);
  await act(async () => {
    jest.advanceTimersByTime(1);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  });
  for (let turn = 0; turn < 5 && tile('merged')?.startsWith('merged4 of 9') !== true; turn++)
    await act(async () => Promise.resolve());
  // Only the keys whose change is not merged were asked about, not the whole board.
  expect(asked).toEqual(['8,3,w']);
  expect(tile('merged')).toBe('merged4 of 9');
  expect(tile('merged today')).toBe('merged today1');
  await unmount();
});

test('while a merge is pending the items are read again on their own, and again after a failure', async () => {
  let reads = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes('/api/items/window')) reads++;
      throw new Error('the server is down');
    },
    { preconnect: failing.preconnect }
  );
  // Nothing invalidates the key: only the page's own re-read can read the items again.
  jest.useFakeTimers();
  setSystemTime(FIXTURE_NOW);
  const { tile, unmount } = await mount('cb-reread', [
    ...PAGE.items,
    readyWithMerge('p', 'pending'),
  ]);
  expect(reads).toBe(0);
  for (let round = 0; round < 2; round++) {
    const before = reads;
    await act(async () => {
      jest.advanceTimersByTime(MERGE_REREAD_MS);
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    });
    expect(reads).toBeGreaterThan(before);
  }
  expect(tile('merged')).toBe('merged3 of 9Checking which changes merged');
  await unmount();
});

test('a failed refresh says so and keeps the last numbers', async () => {
  const { container, tile, unmount } = await mount('cb-stale', PAGE.items);
  await act(async () => invalidate(K.factoryItems('cb-stale')));
  for (let turn = 0; turn < 5; turn++) await settle();
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Could not refresh: the server is down. Showing the last values read.'
  );
  expect(tile('merged')).toBe('merged3 of 8');
  await unmount();
});

test('a view that declares discoveries adds a tile; the tiles are plain figures, nothing to open', async () => {
  set(K.factoryDiscoveries('cb-found'), DISCOVERIES);
  const declared = await mount('cb-found', PAGE.items);
  const strip = declared.container.querySelector('ul[aria-label="Numbers"]');
  if (strip === null) throw new Error('the strip renders');
  expect(strip.querySelectorAll('li')).toHaveLength(6);
  // Two of the three findings: an item carries the third.
  expect(declared.tile('found by the factory')).toBe('found by the factory2');
  expect(strip.querySelectorAll('a, button, [tabindex], [href]')).toHaveLength(0);
  expect(strip.textContent).not.toContain('Open');
  await declared.unmount();

  invalidate(K.factoryDiscoveries('cb-found'));
});
