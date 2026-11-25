import { afterEach, expect, test } from 'bun:test';
import type { ItemRead } from '../../skills/items';
import { listOrderItems, orderSummary, workOrders } from './work-orders';

const ref = (key: string) => ({ id: key, projectKey: 'p', key, title: null });

/** A `part_of` link from or to `other`, active. */
const link = (other: string, direction: 'incoming' | 'outgoing') =>
  ({ kind: 'part_of', direction, ended: null, other: ref(other) }) as ItemRead['links'][number];

function read(
  key: string,
  state: ItemRead['standing']['state'],
  rest: { merged?: boolean; links?: ItemRead['links'] } = {}
): ItemRead {
  return {
    item: ref(key),
    standing: { runId: null, state, pack: null },
    runs: [],
    questions: [],
    links: rest.links ?? [],
    merged: rest.merged === true ? { at: '2026-11-20T10:00:00Z' } : null,
  } as unknown as ItemRead;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a split parent whose pieces all merged reads N of N merged and resolved', () => {
  // #171's shape: the order has no merge of its own and stands done through its parts.
  const [order] = workOrders([
    read('171-a', 'done', { merged: true, links: [link('171', 'outgoing')] }),
    read('171-b', 'done', { merged: true, links: [link('171', 'outgoing')] }),
    read('171', 'done', { links: [link('171-a', 'incoming'), link('171-b', 'incoming')] }),
  ]);
  expect(order === undefined ? null : orderSummary(order)).toEqual({
    merged: 2,
    total: 2,
    unstarted: 0,
    resolved: true,
  });
});

test('every item is read with the own read of each work order the window does not list', async () => {
  // #48's shape: the window lists members with runs; order 48 has none, order 64 is listed.
  const window = [
    read('49', 'done', { merged: true, links: [link('48', 'outgoing')] }),
    read('65', 'done', { merged: true, links: [link('64', 'outgoing')] }),
    read('64', 'done', { links: [link('65', 'incoming')] }),
  ];
  const order48 = read('48', 'done', { links: [link('49', 'incoming'), link('50', 'incoming')] });
  const asked: string[] = [];
  globalThis.fetch = ((url: RequestInfo | URL) => {
    const path = String(url);
    asked.push(path.replace(/\?.*$/, ''));
    const body = path.includes('/api/items/window') ? { items: window, next: null } : order48;
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    );
  }) as typeof fetch;
  const items = await listOrderItems('web');
  // One window read and one item read, for 48 alone.
  expect(asked).toEqual(['/api/items/window', '/api/items']);
  const order = workOrders(items).find(entry => entry.item.key === '48');
  // Its own read names member 50, which has no run, and gives it its standing.
  expect(order === undefined ? null : orderSummary(order)).toEqual({
    merged: 1,
    total: 2,
    unstarted: 1,
    resolved: true,
  });
});
