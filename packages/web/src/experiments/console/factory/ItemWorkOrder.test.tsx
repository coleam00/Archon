import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryItemDetail } from '../skills/factory';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { itemDetail, PROJECT, shippedListed } from './item-detail.test-fixtures';
import { WORK_ORDER_WORDS } from './ItemWorkOrder';
import { projectRoutes } from '../routes/project-routes';

// The item read must fail with a 404 for this page, which only a mounted read reaches.
const dom = new Window({ url: 'http://localhost' });
// The frame keeps the Needs-you count live over SSE; nothing streams in this test.
class QuietEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close(): void {
    this.readyState = 2;
  }
}
const globals = {
  window: dom,
  document: dom.document,
  EventSource: QuietEventSource,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const originalFetch = globalThis.fetch;
// Every read but the item's comes from the cache; the project has no item under the key.
globalThis.fetch = Object.assign(
  async (): Promise<Response> =>
    new Response(JSON.stringify({ error: 'No such item' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }),
  { preconnect: originalFetch.preconnect }
);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

afterEach(() => {
  invalidate('factory-views');
  invalidate('factory-items');
});

type Item = FactoryItemDetail['item'];

/** Item 3, part of `order` by its order run's result, as the items read carries it. */
function member(order: string): Item {
  const { item } = itemDetail('3');
  return { ...item, progress: { ...item.progress!, partOf: order } };
}

async function mount(key: string, items: Item[]): Promise<string> {
  set(K.factoryViews(PROJECT), { views: [shippedListed], errors: [] });
  set(K.projectAttention(PROJECT), { items: [], runs: [], degraded: [] });
  set(K.factoryItems(PROJECT), { items, members: {} });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/console/p/${PROJECT}/factory/items/${key}`]}>
        <Routes>{projectRoutes('/console/')}</Routes>
      </MemoryRouter>
    )
  );
  // The item read's 404 settles after the first render.
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
  const words = (container.textContent ?? '').replace(/\s+/g, ' ');
  await act(async () => root.unmount());
  container.remove();
  return words;
}

test("an order no item row holds, named by a member's order run: its page from the items read", async () => {
  const words = await mount('48', [member('48')]);
  expect(words).toContain(WORK_ORDER_WORDS);
  expect(words).toContain('Back to the overview#48Work order #48');
  expect(words).toContain('Members: 0 of 1 merged');
  expect(words).not.toContain('could not be read');
});

test('a key that is no item and no order says there is none, and offers the board', async () => {
  const words = await mount('404', [member('48')]);
  expect(words).toContain('There is no item #404 in this project.');
  expect(words).not.toContain('could not be read');
});
