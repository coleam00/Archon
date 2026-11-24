import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter } from 'react-router';
import { shippedListed } from '../factory/item-detail.test-fixtures';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { installDom } from '../test-dom.test-helpers';
import { ProjectAttentionProvider } from './ProjectAttention';
import { ProjectViewTabs } from './ProjectViewTabs';

const { dom, mount } = await installDom();
// Anything the tabs read past the seeded views (the attention queue) waits for ever.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => undefined), {
  preconnect: globalThis.fetch.preconnect,
});

afterEach(() => {
  invalidate('factory-views');
  invalidate('runs');
});
const ID = 'cb-tabs';
const tabs = (active: 'runs' | 'factory') =>
  mount(
    <MemoryRouter>
      <ProjectAttentionProvider projectId={ID}>
        <ProjectViewTabs projectId={ID} active={active} />
      </ProjectAttentionProvider>
    </MemoryRouter>
  );

/**
 * happy-dom lays nothing out: a 390 px row whose tabs are `width` wide with 10 px between them,
 * for the length of `run`.
 */
async function withLayout(width: (tab: Element) => number, run: () => Promise<void>) {
  const proto = dom.HTMLElement.prototype;
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
  try {
    await run();
  } finally {
    for (const [key, original] of originals)
      if (original) Object.defineProperty(proto, key, original);
      else Reflect.deleteProperty(proto, key);
  }
}

test('the project tabs, in order, with Factory once the views are read', async () => {
  set(K.factoryViews(ID), { views: [shippedListed], errors: [] });
  const page = await tabs('runs');
  expect([...page.container.querySelectorAll('a')].map(tab => tab.textContent)).toEqual([
    'Needs you',
    'Runs',
    'Chat',
    'Metrics',
    'Factory',
  ]);
  await page.unmount();
});

test('on a phone the active Factory tab, last in the row, is scrolled into view once it joins', async () => {
  // Each tab is 90 px: Factory sits at 400..490, so the row scrolls 100 px to show it whole.
  await withLayout(
    () => 90,
    async () => {
      const page = await tabs('factory');
      const row = page.container.querySelector<HTMLElement>('a')?.parentElement;
      expect(row?.scrollLeft).toBe(0);
      await act(async () => set(K.factoryViews(ID), { views: [shippedListed], errors: [] }));
      expect(row?.scrollLeft).toBe(100);
      await page.unmount();
    }
  );
});
