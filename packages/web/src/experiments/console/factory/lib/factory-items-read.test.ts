import { expect, mock, test } from 'bun:test';
import type { FactoryItem } from '../../skills/factory';
import type { ItemWindow } from '../../skills/items';
import { deadlineOf, FACTORY_READ_DEADLINE_MS } from './deadline';
import { readEveryFactoryItem, readEveryItem, type FactoryItemsReads } from './factory-items-read';
import { capturedItemsPage } from './fixtures/factory-items-page';

const captured = capturedItemsPage.items;
const within = deadlineOf(FACTORY_READ_DEADLINE_MS);

const read = ({ progress: _progress, ...rest }: FactoryItem): ItemWindow['items'][number] => rest;
const page = (items: FactoryItem[], next: string | null): ItemWindow => ({
  window: { since: '1970-01-01T00:00:00.000Z', until: '2026-11-17T12:00:00.000Z' },
  items: items.map(read),
  next,
});
/** `item` renamed `key`, its runs ending at `at`. */
const at = (item: FactoryItem, key: string, end: string): FactoryItem => ({
  ...item,
  item: { ...item.item, id: `id-${key}`, key },
  runs: item.runs.map(run => ({ ...run, startedAt: end, completedAt: end })),
});

/**
 * The fakes the walk reads through. `rows` are the keys the project has an item row under
 * beyond the captured page's (a work order with no run); `links` the members linked to each.
 */
function reads(
  pages: ItemWindow[],
  failProgress = false,
  rows: readonly string[] = [],
  links: Record<string, string[]> = {}
) {
  const windowCalls: Parameters<FactoryItemsReads['listWindow']>[0][] = [];
  const progressCalls: Parameters<FactoryItemsReads['getProgress']>[0][] = [];
  const all = new Map(captured.map(item => [item.item.key, item.progress]));
  const deps: FactoryItemsReads = {
    listWindow: mock(async opts => {
      windowCalls.push(opts);
      return pages[windowCalls.length - 1] ?? page([], null);
    }),
    getProgress: mock(async opts => {
      progressCalls.push(opts);
      if (failProgress) throw new Error('progress failed');
      const keys = typeof opts.keys === 'string' ? [opts.keys] : opts.keys;
      const known = (key: string): boolean =>
        all.has(key) ||
        rows.includes(key) ||
        pages.some(p => p.items.some(i => i.item.key === key));
      return {
        pack: 'p',
        progress: Object.fromEntries(
          keys.flatMap((k: string) => (all.has(k) ? [[k, all.get(k) ?? null]] : []))
        ),
        members: Object.fromEntries(keys.filter(known).map((k: string) => [k, links[k] ?? []])),
      };
    }),
  };
  return { deps, windowCalls, progressCalls };
}

test('walks the window from far back, then by its cursor alone, joining each page with its progress', async () => {
  const [first, second] = captured;
  const { deps, windowCalls, progressCalls } = reads([page([first!], 'c1'), page([second!], null)]);
  const { items } = await readEveryFactoryItem('cb-1', deps, within);
  expect(windowCalls).toEqual([
    { project: 'cb-1', since: '1970-01-01T00:00:00Z', limit: 100 },
    { project: 'cb-1', after: 'c1', limit: 100 },
  ]);
  expect(progressCalls).toEqual([
    { codebaseId: 'cb-1', keys: [first!.item.key] },
    { codebaseId: 'cb-1', keys: [second!.item.key] },
  ]);
  expect(items.map(item => item.progress)).toEqual(
    expect.arrayContaining([first!.progress, second!.progress])
  );
});

test('newest activity first, ties by item id, whatever order the window pages in', async () => {
  const base = captured[0]!;
  const { deps } = reads([
    page(
      [at(base, 'old', '2026-11-10T00:00:00.000Z'), at(base, 'b', '2026-11-12T00:00:00.000Z')],
      'c1'
    ),
    page(
      [at(base, 'a', '2026-11-12T00:00:00.000Z'), at(base, 'new', '2026-11-15T00:00:00.000Z')],
      null
    ),
  ]);
  const { items } = await readEveryFactoryItem('cb-1', deps, within);
  expect(items.map(item => item.item.key)).toEqual(['new', 'a', 'b', 'old']);
});

/** `item` renamed `key`, part of `order` by an active link, or by its order run's result. */
const member = (key: string, order: string, by: 'link' | 'output'): FactoryItem => {
  const base = at(captured[0]!, key, '2026-11-17T00:00:00.000Z');
  const link = {
    id: `link-${key}`,
    kind: 'part_of' as const,
    direction: 'outgoing' as const,
    other: { id: `id-${order}`, projectKey: base.item.projectKey, key: order },
    at: '2026-11-17T00:00:00.000Z',
    via: 'cli' as const,
    by: null,
    fromRun: null,
    ended: null,
  };
  return by === 'link' ? { ...base, links: [link] } : base;
};

test('orders the window lacks are read after the walk, together, never one request each', async () => {
  // 48 has an item row and no run; 60 is named only by a result and has no row at all.
  const { deps, progressCalls } = reads(
    [
      page(
        [member('49', '48', 'link'), member('50', '48', 'link'), member('52', '60', 'output')],
        null
      ),
    ],
    false,
    ['48'],
    { '48': ['49', '50', '51'] }
  );
  const byOutput: FactoryItemsReads = {
    ...deps,
    getProgress: async (opts, init) => {
      const answer = await deps.getProgress(opts, init);
      const keys = typeof opts.keys === 'string' ? [opts.keys] : opts.keys;
      // 52's order run named 60; 50's named 61, which its link to 48 overrides.
      const progress = { ...answer.progress };
      const named = { '50': '61', '52': '60' } as const;
      for (const [key, partOf] of Object.entries(named))
        if (keys.includes(key)) progress[key] = { ...captured[0]!.progress!, partOf };
      return { ...answer, progress };
    },
  };
  const read = await readEveryFactoryItem('cb-1', byOutput, within);
  expect(progressCalls.map(call => call.keys)).toEqual([
    ['49', '50', '52'],
    ['48', '60'],
  ]);
  // 51 is linked and has no run: it is no item, and counts as 48's member.
  expect(read.items.map(item => item.item.key).sort()).toEqual(['49', '50', '52']);
  expect(read.members['48']).toEqual(['49', '50', '51']);
  // An order with no item row is absent from the members map.
  expect('60' in read.members).toBe(false);
});

test('with no factory view it walks the window alone, never the progress read, newest first', async () => {
  const [first, second] = captured;
  const older = at(first!, 'old', '2026-11-10T00:00:00.000Z');
  const newer = at(second!, 'new', '2026-11-12T00:00:00.000Z');
  const { deps, windowCalls, progressCalls } = reads([page([older], 'c1'), page([newer], null)]);
  const items = await readEveryItem('cb-1', deps.listWindow, within);
  expect(items.map(item => item.item.key)).toEqual(['new', 'old']);
  expect(items[0]).not.toHaveProperty('progress');
  expect(windowCalls).toHaveLength(2);
  expect(progressCalls).toEqual([]);
});
