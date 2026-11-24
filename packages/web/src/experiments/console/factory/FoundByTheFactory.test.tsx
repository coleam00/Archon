import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { invalidate, set } from '../store/cache';
import { formatDateTime } from '../lib/format';
import { K } from '../store/keys';
import { FoundByTheFactory, FoundByTheFactoryLine } from './FoundByTheFactory';
import { DISCOVERIES } from './lib/discoveries.test-fixtures';
import type { ItemName } from '../lib/ask-naming';

// A failed read follows a render, which static markup cannot reach.
const dom = new Window({ url: 'http://localhost' });
const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (): Promise<Response> => {
    throw new Error('the server is down');
  },
  { preconnect: originalFetch.preconnect }
);

const ID = 'cb-found';
afterEach(() => {
  invalidate('factory-items');
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

/** The line and the opened panel, as the board draws them with its strips open. */
async function mount(names: ReadonlyMap<string, ItemName> = new Map()) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/console/p/${ID}/factory/board`]}>
        <div data-line>
          <FoundByTheFactoryLine projectId={ID} />
        </div>
        <div data-body>
          <FoundByTheFactory projectId={ID} names={names} />
        </div>
      </MemoryRouter>
    )
  );
  return {
    container,
    line: container.querySelector('[data-line]')!,
    body: container.querySelector('[data-body]')!,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('the line: its name, the shadow badge and the count', async () => {
  set(K.factoryDiscoveries(ID), DISCOVERIES);
  const { line, unmount } = await mount();
  try {
    expect(line.querySelector('h2')?.textContent).toBe('Found by the factory');
    expect(line.textContent).toContain('shadow');
    expect(line.querySelector('[data-found-count]')?.textContent).toBe('2');
    expect(line.textContent).toContain('the factory would file');
    // One line: no chips, no shadow sentence, no list.
    expect(line.querySelector('ul')).toBeNull();
    expect(line.textContent).not.toContain('files nothing yet');
  } finally {
    await unmount();
  }
});

test('opened: the count no item covers, the chips, the shadow line and the findings listed', async () => {
  set(K.factoryDiscoveries(ID), DISCOVERIES);
  const { body, unmount } = await mount();
  try {
    // The heading is the line's, once on the page.
    expect(body.querySelector('h2')).toBeNull();
    expect(body.textContent).toContain('files nothing yet');
    expect(body.querySelector('[data-found-count]')?.textContent).toBe('2');
    const chips = [...body.querySelectorAll('[aria-label="What the drains decided"] li')];
    expect(chips.map(li => li.textContent)).toEqual(['would file 3', 'held 10', 'dropped 16']);
    // One finding an item covers, and one drain that could not be read.
    expect(body.textContent).toMatch(/1 already on the board/);
    expect(body.textContent).toMatch(/1 drain could not be read/);
    // Listed at once: the board's toggle opened it, and nothing inside it toggles again.
    expect(body.querySelector('button')).toBeNull();
    const rows = [...body.querySelectorAll('#found-by-the-factory-list > li')];
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first?.textContent).toContain('Defect');
    expect(first?.textContent).toContain('A dev:console server on a seeded copy');
    expect(first?.textContent).toContain('#58 · Items window read takes ~1.1 s');
    // When that drain decided, as the board's cards word a time.
    expect(first?.textContent).toContain(formatDateTime(DISCOVERIES.findings[0]!.decidedAt));
    expect(first?.querySelector('a')?.getAttribute('href')).toBe(
      '/console/p/cb-found/factory/items/58'
    );
    // The verified line is on hover, and read out to a screen reader.
    expect(first?.getAttribute('title')).toBe(DISCOVERIES.findings[0]?.verified ?? '');
    expect(first?.querySelector('.sr-only')?.textContent).toContain('Verified:');
    expect(second?.textContent).toContain('Cleanup');
    expect(second?.hasAttribute('title')).toBe(false);
    // The covered finding is not listed.
    expect(body.textContent).not.toContain('CI runs the packages');
  } finally {
    await unmount();
  }
});

test('not a shadow: no badge and no line', async () => {
  set(K.factoryDiscoveries(ID), { ...DISCOVERIES, shadow: false });
  const { container, line, unmount } = await mount();
  try {
    expect(container.textContent).not.toContain('shadow');
    expect(container.textContent).not.toContain('files nothing yet');
    expect(line.textContent).toContain('filed, not on the board yet');
    expect(container.textContent).toContain('filed 3');
  } finally {
    await unmount();
  }
});

test('nothing open reads as an empty state on both, not a zero list', async () => {
  set(K.factoryDiscoveries(ID), { ...DISCOVERIES, findings: [], unreadable: 0 });
  const { line, body, unmount } = await mount();
  try {
    expect(line.textContent).toContain('Nothing the factory would file now');
    expect(body.textContent).toContain('Nothing the factory would file now.');
    expect(body.querySelector('#found-by-the-factory-list')).toBeNull();
  } finally {
    await unmount();
  }
});

test('a read that fails says so once, on the line; the opened panel draws nothing', async () => {
  const { container, line, body, unmount } = await mount();
  try {
    for (let turn = 0; turn < 5 && container.querySelector('[role="alert"]') === null; turn++)
      await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    expect(line.querySelector('[role="alert"]')?.textContent).toContain('the server is down');
    expect(body.children).toHaveLength(0);
  } finally {
    await unmount();
  }
});

test('a finding from a split member names it under its order; its link keeps the key', async () => {
  const KEY = 'issue-136-item-keys';
  set(K.factoryDiscoveries(ID), {
    ...DISCOVERIES,
    findings: [{ ...DISCOVERIES.findings[0]!, from: { key: KEY, title: null } }],
  });
  const names = new Map([[KEY, { title: null, partOf: 'issue-136' }]]);
  const { container, unmount } = await mount(names);
  try {
    const link = container.querySelector(`#found-by-the-factory-list a[href$="/items/${KEY}"]`);
    expect(link?.textContent).toBe('#136 · item keys');
  } finally {
    await unmount();
  }
});
