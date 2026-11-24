import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { shippedListed } from '../factory/item-detail.test-fixtures';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { askItem } from '../lib/needs-you.test-fixtures';
import { ProjectAttentionProvider } from './ProjectAttention';
import { ProjectViewTabs } from './ProjectViewTabs';

const dom = new Window({ url: 'http://localhost' });
/** The tabs' attention stream, which says nothing here. */
class QuietEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close(): void {
    this.readyState = 2;
  }
}
/**
 * A ResizeObserver the tests fire by hand (`resize`). As in a browser, only an observer watching
 * the element whose size changed is called, so a test proves which elements are watched.
 */
class HandResizeObserver {
  static live = new Set<HandResizeObserver>();
  readonly watched = new Set<Element>();
  constructor(private readonly callback: () => void) {}
  observe(el: Element): void {
    this.watched.add(el);
    HandResizeObserver.live.add(this);
  }
  disconnect(): void {
    HandResizeObserver.live.delete(this);
  }
  static resize(el: Element): void {
    for (const observer of HandResizeObserver.live)
      if (observer.watched.has(el)) observer.callback();
  }
}
const globals = {
  window: dom,
  document: dom.document,
  EventSource: QuietEventSource,
  ResizeObserver: HandResizeObserver,
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
// Anything the tabs read past the seeded views (the attention queue) waits for ever.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => undefined), {
  preconnect: originalFetch.preconnect,
});

afterEach(() => invalidate('factory-views'));
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const ID = 'cb-tabs';

test('on a phone the project tabs stay one line and scroll sideways, no tab squeezed', async () => {
  set(K.factoryViews(ID), { views: [shippedListed], errors: [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ProjectAttentionProvider projectId={ID}>
            <ProjectViewTabs projectId={ID} active="runs" />
          </ProjectAttentionProvider>
        </MemoryRouter>
      )
    );
    const row = container.querySelector<HTMLElement>('a')?.parentElement;
    const classes = row?.className.split(' ') ?? [];
    expect(classes).toContain('flex-nowrap');
    expect(classes).toContain('overflow-x-auto');
    const tabs = [...container.querySelectorAll('a')];
    expect(tabs.map(tab => tab.textContent)).toEqual([
      'Needs you',
      'Runs',
      'Chat',
      'Metrics',
      'Factory',
    ]);
    for (const tab of tabs) {
      expect(tab.className).toContain('shrink-0');
      expect(tab.className).toContain('whitespace-nowrap');
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('on a phone the active Factory tab, last in the row, is scrolled into view', async () => {
  // happy-dom lays nothing out: each tab is 90 px wide, 100 px after the last, in a 390 px row,
  // so Factory sits at 400..490 and the row must scroll 100 px to show it whole.
  const proto = dom.HTMLElement.prototype;
  const stubbed = {
    clientWidth: () => 390,
    offsetWidth: () => 90,
    offsetLeft(this: HTMLElement) {
      const parent = this.parentElement;
      return parent === null ? 0 : [...parent.children].indexOf(this) * 100;
    },
  };
  const originals = Object.keys(stubbed).map(
    key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const
  );
  for (const [key, get] of Object.entries(stubbed))
    Object.defineProperty(proto, key, { configurable: true, get });
  // Factory joins once the views are read: the row reveals it then too.
  invalidate('factory-views');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    const render = () =>
      root.render(
        <MemoryRouter>
          <ProjectAttentionProvider projectId={ID}>
            <ProjectViewTabs projectId={ID} active="factory" />
          </ProjectAttentionProvider>
        </MemoryRouter>
      );
    await act(async () => render());
    const row = container.querySelector<HTMLElement>('a')?.parentElement;
    expect(row?.scrollLeft).toBe(0);
    await act(async () => set(K.factoryViews(ID), { views: [shippedListed], errors: [] }));
    expect(row?.scrollLeft).toBe(100);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const [key, original] of originals)
      if (original) Object.defineProperty(proto, key, original);
      else Reflect.deleteProperty(proto, key);
  }
});

test('a Needs-you badge widening a tab before the active one keeps the active tab in view', async () => {
  // happy-dom lays nothing out: a tab is 90 px wide, 120 px with its waiting badge, and 10 px
  // after the last, in a 390 px row. Factory sits at 400..490, then at 430..520 once Needs you
  // grows its badge.
  const proto = dom.HTMLElement.prototype;
  const width = (el: Element): number => (el.querySelector('[aria-label$="waiting"]') ? 120 : 90);
  const stubbed = {
    clientWidth: () => 390,
    offsetWidth(this: HTMLElement) {
      return width(this);
    },
    offsetLeft(this: HTMLElement) {
      const parent = this.parentElement;
      if (parent === null) return 0;
      const before = [...parent.children].slice(0, [...parent.children].indexOf(this));
      return before.reduce((left, tab) => left + width(tab) + 10, 0);
    },
  };
  const originals = Object.keys(stubbed).map(
    key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const
  );
  for (const [key, get] of Object.entries(stubbed))
    Object.defineProperty(proto, key, { configurable: true, get });
  set(K.factoryViews(ID), { views: [shippedListed], errors: [] });
  set(K.projectAttention(ID), { items: [], runs: [], degraded: [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ProjectAttentionProvider projectId={ID}>
            <ProjectViewTabs projectId={ID} active="factory" />
          </ProjectAttentionProvider>
        </MemoryRouter>
      )
    );
    const row = container.querySelector<HTMLElement>('a')?.parentElement;
    expect(row?.scrollLeft).toBe(100);
    // An ask opens over the stream: the badge appears, and the browser reports the resize.
    await act(async () =>
      set(K.projectAttention(ID), { items: [askItem()], runs: [], degraded: [] })
    );
    // Only the tab holding the badge changes size; the tabs after it move but keep theirs.
    const widened = container.querySelector('[aria-label$="waiting"]')?.closest('a');
    if (widened == null) throw new Error('No Needs-you badge');
    await act(async () => HandResizeObserver.resize(widened));
    expect(row?.scrollLeft).toBe(130);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    invalidate('runs');
    for (const [key, original] of originals)
      if (original) Object.defineProperty(proto, key, original);
      else Reflect.deleteProperty(proto, key);
  }
});
