import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { ProjectAttentionProvider } from '../components/ProjectAttention';
import { Board } from './BoardPage';
import type { FactoryItem } from '../skills/factory';
import {
  endLastRun,
  idleInPlan,
  keepRuns,
  needsShaping,
  PAGE,
  parkedByTriage,
  readyWithMerge,
  realItem,
  VIEW,
  FIXTURE_NOW,
} from './lib/board.test-fixtures';
import { DISCOVERIES } from './lib/discoveries.test-fixtures';
import { boardModel } from './lib/board';
import { timeToLand } from './lib/board-table';
import { factoryNumbers } from './lib/numbers';
import { cancelRereads } from './merge-reread';
import { cancelMergeWatches } from './merge-watch';
import { formatDateTime } from '../lib/format';
import { boardColumns } from './lib/board-columns';

// Filtering, sorting and the move highlight follow a re-render, which static markup cannot reach.
const dom = new Window({ url: 'http://localhost' });
/** The project's attention stream, which says nothing here. */
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
// Every read comes from the cache the test sets; a fetch would mean a key was missed.
globalThis.fetch = Object.assign(
  async (): Promise<Response> => {
    throw new Error('the board test fetched');
  },
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

const ID = 'cb-1';
/** `board` under a project queue where nothing waits on a person: the ask face has its own tests (BoardAsks.test.tsx). */
function quiet(board: ReactElement): ReactElement {
  set(K.projectAttention(ID), { items: [], runs: [], degraded: [] });
  return <ProjectAttentionProvider projectId={ID}>{board}</ProjectAttentionProvider>;
}
// The Merged column lists the last 7 local days; the fixtures merged on 2026-11-17.
const NOW = new Date(2026, 10, 18, 12, 0);
const DAY = 24 * 60 * 60 * 1000;
afterEach(() => {
  cancelRereads();
  cancelMergeWatches();
  invalidate('factory-items');
});

async function mount(
  items: FactoryItem[],
  path = `/console/p/${ID}/factory/board`,
  members: Record<string, string[]> = {}
) {
  set(K.factoryItems(ID), { items, members });
  // The view declares discoveries, so the board mounts the "Found by the factory" panel.
  set(K.factoryDiscoveries(ID), DISCOVERIES);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/console/p/:projectId/factory/board"
            element={quiet(<Board projectId={ID} view={VIEW} now={NOW} />)}
          />
        </Routes>
      </MemoryRouter>
    )
  );
  return {
    container,
    unmount: async (): Promise<void> => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Each column's label and count, as its header shows them ("checking" while it waits). */
const headers = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('header[data-column]')].map(
    header =>
      `${header.querySelector('h3')?.textContent ?? ''}${header.querySelector('[data-count]')?.textContent ?? ''}`
  );

/** A column's section by its label. */
const columnNamed = (container: HTMLElement, label: string): Element | null =>
  container.querySelector(`section[aria-label="${label}"]`);

const cardKeys = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('article')].map(card => card.getAttribute('data-card') ?? '');

describe('before the items are read', () => {
  test("the board draws the final layout's shape: a skeleton column per declared column", async () => {
    const quietFetch = globalThis.fetch;
    // A read that never answers: the board stays in its loading state.
    globalThis.fetch = Object.assign(async (): Promise<Response> => new Promise(() => {}), {
      preconnect: originalFetch.preconnect,
    });
    set(K.factoryDiscoveries(ID), DISCOVERIES);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={[`/console/p/${ID}/factory/board`]}>
            {quiet(<Board projectId={ID} view={VIEW} now={NOW} />)}
          </MemoryRouter>
        )
      );
      expect(headers(container)).toEqual(
        boardColumns(VIEW).map(column => `${column.label}loading`)
      );
      const columns = [...container.querySelectorAll('section[aria-label]')].filter(section =>
        section.querySelector('header[data-column]')
      );
      for (const column of columns)
        expect(column.querySelectorAll('[data-skeleton="block"]')).toHaveLength(2);
      expect(container.querySelector('[aria-label="Board view"]')).not.toBeNull();
      expect(container.textContent).not.toContain('Loading…');
      expect(container.textContent).not.toContain('…');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = quietFetch;
    }
  });
});

/** Items the board sets aside: one ended, one long idle, one parked. */
const setAsideItems = (): FactoryItem[] => [
  endLastRun(keepRuns(realItem('6'), 1), 'completed', 'fold'),
  idleInPlan('i', new Date(NOW.getTime() - 4 * DAY).toISOString()),
  parkedByTriage('p'),
];

/** The one toggle under the board, which opens both strips. */
const stripsToggle = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector('[data-board-strips] > button');

const viewButton = (container: HTMLElement, label: 'Pipeline' | 'Table'): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find(
    button => button.textContent === label
  ) as HTMLButtonElement;

describe('the strips under the board', () => {
  test('a view that declares discoveries draws the Found line under the columns', async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      const line = container.querySelector(
        '[data-board-strips] section[aria-labelledby="found-by-the-factory-heading"]'
      );
      expect(line?.querySelector('h2')?.textContent).toBe('Found by the factory');
      // One line (owner ruling), so the columns keep their height: the panel's chips are not
      // drawn until the toggle opens it.
      expect(stripsToggle(container)?.textContent).toBe('show them');
      expect(stripsToggle(container)?.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('ul[aria-label="What the drains decided"]')).toBeNull();
      const lastColumn = [...container.querySelectorAll('header[data-column]')].at(-1);
      expect(lastColumn).toBeDefined();
      // After every column in document order: under the board, not above it.
      expect(
        lastColumn!.compareDocumentPosition(line!) & dom.Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    } finally {
      await unmount();
    }
  });

  test('one toggle opens and closes Found by the factory and Set aside together', async () => {
    const { container, unmount } = await mount([...setAsideItems(), realItem('7')]);
    try {
      const line = container.querySelector('[data-board-strips]');
      // One control for both: neither line card has a button of its own.
      expect(line?.querySelectorAll('button')).toHaveLength(1);
      expect(line?.querySelectorAll('section button')).toHaveLength(0);
      const toggle = stripsToggle(container);
      await act(async () => toggle?.click());
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle?.textContent).toBe('hide them');
      expect(container.querySelector('#found-by-the-factory-list')).not.toBeNull();
      expect(container.querySelector('#set-aside-list')).not.toBeNull();
      await act(async () => toggle?.click());
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('#found-by-the-factory-list')).toBeNull();
      expect(container.querySelector('#set-aside-list')).toBeNull();
    } finally {
      await unmount();
    }
  });

  test('neither strip is absolutely or fixed positioned, open or closed', async () => {
    const { container, unmount } = await mount([...setAsideItems(), realItem('7')]);
    try {
      const positioned = (): string[] =>
        [
          ...container.querySelectorAll(
            '[data-board-strips], [data-board-strips] *, [data-board-strips-open], [data-board-strips-open] *'
          ),
        ]
          // The shadow accent bar is decoration drawn inside its own card.
          .filter(element => !element.hasAttribute('aria-hidden'))
          .filter(element =>
            [...element.classList].some(token => /(^|:)(absolute|fixed)$/.test(token))
          )
          .map(element => element.outerHTML.slice(0, 80));
      expect(positioned()).toEqual([]);
      await act(async () => stripsToggle(container)?.click());
      expect(container.querySelector('[data-board-strips-open]')).not.toBeNull();
      expect(positioned()).toEqual([]);
    } finally {
      await unmount();
    }
  });

  test('opened in the Table, every row is drawn above the strips, outside the table', async () => {
    const items = [...setAsideItems(), ...PAGE.items];
    const { container, unmount } = await mount(items, `/console/p/${ID}/factory/board?view=table`);
    try {
      await act(async () => stripsToggle(container)?.click());
      const opened = container.querySelector('[data-board-strips-open]');
      const table = container.querySelector('table');
      expect(opened).not.toBeNull();
      expect(container.querySelectorAll('tbody tr')).toHaveLength(PAGE.items.length);
      expect(
        table!.compareDocumentPosition(opened!) & dom.Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(table!.parentElement?.contains(opened)).toBe(false);
    } finally {
      await unmount();
    }
  });

  test('switching Pipeline and Table leaves the strips as they were', async () => {
    const { container, unmount } = await mount([...setAsideItems(), realItem('7')]);
    try {
      await act(async () => stripsToggle(container)?.click());
      await act(async () => viewButton(container, 'Table').click());
      expect(container.querySelector('table')).not.toBeNull();
      expect(container.querySelector('#set-aside-list')).not.toBeNull();
      await act(async () => viewButton(container, 'Pipeline').click());
      expect(container.querySelector('table')).toBeNull();
      expect(container.querySelector('#set-aside-list')).not.toBeNull();
      expect(stripsToggle(container)?.textContent).toBe('hide them');
    } finally {
      await unmount();
    }
  });

  test('one strip with something to say still gets the line and the toggle; none, no line', async () => {
    const noStrip = { ...VIEW, discoveries: undefined };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = async (items: FactoryItem[]): Promise<void> => {
      set(K.factoryItems(ID), { items, members: {} });
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={[`/console/p/${ID}/factory/board`]}>
            {quiet(<Board projectId={ID} view={noStrip} now={NOW} />)}
          </MemoryRouter>
        )
      );
    };
    try {
      await render([...setAsideItems(), realItem('7')]);
      expect(container.querySelector('#found-by-the-factory-heading')).toBeNull();
      expect(container.querySelector('#set-aside-heading')?.textContent).toBe('3 set aside');
      expect(stripsToggle(container)).not.toBeNull();
      await render(PAGE.items);
      expect(container.querySelector('[data-board-strips]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe('the Pipeline view', () => {
  test('one column per declared column with its count, every real item in its column', async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      expect(headers(container)).toEqual([
        'Intake0',
        'Plan & build4',
        'Checks & review1',
        'Ready to merge0',
        'Merged3',
      ]);
      const checks = columnNamed(container, 'Checks & review');
      expect(
        checks?.querySelector('a[aria-label="Checks · Product check · round 1"]')
      ).not.toBeNull();
      // The card opens its item page.
      expect(checks?.querySelector(`a[href="/console/p/${ID}/factory/items/8"]`)).not.toBeNull();
      expect(checks?.querySelector('a[href^="/console/p/cb-1/r/"]')).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  test('the filter narrows the cards by key or title', async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      const input = container.querySelector('input[type="search"]') as HTMLInputElement;
      await act(async () => {
        // React listens for the native input event; set the value the way a keystroke does.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
        setter?.call(input, 'needs you');
        input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
      });
      expect(cardKeys(container)).toEqual(['7']);
      expect(headers(container)).toContain('Merged1');
    } finally {
      await unmount();
    }
  });

  /**
   * Items made members by their order runs' results; by default 5 and 2 are part of 48 and 4
   * is part of 8, an order with runs.
   */
  const withOrders = (
    named: Record<string, string> = { '5': '48', '2': '48', '4': '8' }
  ): FactoryItem[] =>
    PAGE.items.map(item =>
      item.item.key in named
        ? { ...item, progress: { ...item.progress!, partOf: named[item.item.key]! } }
        : item
    );
  /** The work orders section's header toggle. */
  const summary = (container: HTMLElement): HTMLButtonElement | undefined =>
    [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(button =>
      button.textContent?.includes('work order')
    );
  const card = (container: HTMLElement, key: string) =>
    [...container.querySelectorAll('article')].find(
      article => article.getAttribute('data-card') === key
    );

  test('the work orders are a section above the columns, open, at the board text size', async () => {
    // 48's members 5 and 4 are running, so it is open; 8's only member, 2, merged, so it is not.
    const { container, unmount } = await mount(withOrders({ '5': '48', '4': '48', '2': '8' }));
    try {
      const button = summary(container);
      expect(button?.textContent).toBe('2 work orders · 1 open');
      expect(button?.className).toContain('text-console-14');
      expect(button?.className).not.toContain('text-console-12');
      // Its own section, not a part of the filter's toolbar line, and before the columns.
      const section = button?.closest('section') ?? null;
      const toolbar = container.querySelector('input[type="search"]')?.parentElement;
      expect(section).not.toBeNull();
      expect(toolbar?.contains(section)).toBe(false);
      // In document order, so the section comes before the first column.
      expect(
        container.querySelector('section[aria-label="Work orders section"], header[data-column]')
      ).toBe(section);
      // Listed without a click.
      expect(button?.getAttribute('aria-expanded')).toBe('true');
      const list = container.querySelector('ul[aria-label="Work orders"]');
      expect(list?.id).toBe(button?.getAttribute('aria-controls') ?? '');
      expect(
        [...(list?.querySelectorAll('li[data-order]') ?? [])].map(row =>
          row.getAttribute('data-order')
        )
      ).toEqual(['48', '8']);
      await act(async () => button?.click());
      expect(button?.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('li[data-order]')).toBeNull();
    } finally {
      await unmount();
    }
  });

  test('a work order: its row, a chip on each member, members lit on demand', async () => {
    const { container, unmount } = await mount(withOrders(), undefined, { '48': ['9'] });
    try {
      const strip = container.querySelector('ul[aria-label="Work orders"]');
      const row = strip?.querySelector('li[data-order="48"]');
      expect(row?.textContent).toContain('1 of 3 merged');
      // The row is one link to the order's page, its key and title; 48 has no title of its own.
      expect(row?.querySelectorAll('a')).toHaveLength(1);
      expect(row?.querySelector('a')?.getAttribute('href')).toBe(
        `/console/p/${ID}/factory/items/48`
      );
      expect(row?.querySelector('a')?.textContent).toBe('#48Work order #48');
      expect(
        [...(row?.querySelectorAll('[role="img"][title]') ?? [])].map(dot =>
          dot.getAttribute('title')
        )
      ).toEqual(['#5: Running', '#2: Merged', '#9: Waiting']);
      // A run-less order's row is its key; one with runs shows its key and its own title.
      const withRuns = strip?.querySelector('li[data-order="8"]');
      expect(withRuns?.querySelectorAll('a')).toHaveLength(1);
      expect(withRuns?.querySelector('a')?.getAttribute('href')).toBe(
        `/console/p/${ID}/factory/items/8`
      );
      expect(withRuns?.querySelector('a')?.textContent).toBe(`#8${realItem('8').progress!.title!}`);
      expect(card(container, '5')?.querySelector('a[href$="?order=48"]')?.textContent).toBe(
        'part of #48'
      );
      expect(card(container, '6')?.textContent).not.toContain('part of');
      const toggle = row?.querySelector('button[aria-pressed]') as HTMLButtonElement;
      expect(toggle.closest('a')).toBeNull();
      await act(async () => toggle.click());
      const dimmed = [...container.querySelectorAll('article[data-dimmed="true"]')];
      expect(dimmed).toHaveLength(PAGE.items.length - 2);
      expect(card(container, '5')?.dataset.dimmed).toBeUndefined();
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
    } finally {
      await unmount();
    }
  });

  test('a lit work order is named on the header line, and cleared from there', async () => {
    const { container, unmount } = await mount(
      withOrders(),
      `/console/p/${ID}/factory/board?order=48`,
      {
        '48': ['9'],
      }
    );
    try {
      const line = summary(container)?.parentElement;
      expect(summary(container)?.getAttribute('aria-expanded')).toBe('true');
      expect(line?.textContent).toContain('highlighting #48');
      expect(container.querySelectorAll('article[data-dimmed="true"]')).toHaveLength(
        PAGE.items.length - 2
      );
      const clear = [...(line?.querySelectorAll('button') ?? [])].find(
        button => button.textContent === 'Clear highlight'
      );
      await act(async () => clear?.click());
      expect(summary(container)?.parentElement?.textContent).not.toContain('highlighting');
      expect(container.querySelectorAll('article[data-dimmed="true"]')).toHaveLength(0);
    } finally {
      await unmount();
    }
  });

  test('a key no work order has lights nothing and is not named', async () => {
    const { container, unmount } = await mount(
      withOrders(),
      `/console/p/${ID}/factory/board?order=nope`,
      { '48': ['9'] }
    );
    try {
      expect(summary(container)?.parentElement?.textContent).not.toContain('highlighting');
      expect(container.querySelectorAll('article[data-dimmed="true"]')).toHaveLength(0);
    } finally {
      await unmount();
    }
  });

  test('no work order with a member on the board, no summary line', async () => {
    // 9 is linked to 48 and has no run yet: 48 has its page, nothing on the board to light.
    const { container, unmount } = await mount(PAGE.items, undefined, { '48': ['9'] });
    try {
      expect(container.textContent).not.toContain('work order');
      expect(summary(container)).toBeUndefined();
    } finally {
      await unmount();
    }
  });

  test('items with nothing left to happen fold into one Set aside line under the board', async () => {
    const { container, unmount } = await mount([...setAsideItems(), realItem('7')]);
    try {
      expect(cardKeys(container)).toEqual(['7']);
      // Endings no longer have toolbar rows: the board has no folded row at all.
      expect(container.querySelector('details')).toBeNull();
      expect(
        container.querySelector('[data-board-strips] section[aria-labelledby="set-aside-heading"]')
          ?.textContent
      ).toBe('3 set aside');
      await act(async () => stripsToggle(container)?.click());
      const strip = container.querySelector('#set-aside-list');
      // Each row by its key (the order is the model's), as its leaves: key, title, why, when.
      const row = (key: string): (string | null)[] | undefined => {
        const li = [...(strip?.querySelectorAll('li') ?? [])].find(
          item => item.querySelector('a')?.textContent === key
        );
        if (li === undefined) return undefined;
        return [...li.querySelectorAll('a, span')]
          .filter(element => element.children.length === 0)
          .map(element => element.textContent);
      };
      expect(strip?.querySelectorAll('li')).toHaveLength(3);
      const link = [...(strip?.querySelectorAll('li a') ?? [])].find(a => a.textContent === '#6');
      expect(link?.getAttribute('href')).toBe(`/console/p/${ID}/factory/items/6`);
      const title = realItem('6').progress?.title ?? '';
      expect(row('p')).toEqual([
        'p',
        title,
        'Parked by triage',
        formatDateTime(parkedByTriage('p').runs[0]?.completedAt ?? ''),
      ]);
      expect(row('i')?.[2]).toBe('No change was proposed');
      expect(row('#6')?.[2]).toBe('Folded into another item');
      expect(strip?.textContent).not.toMatch(/archived|deleted/i);
    } finally {
      await unmount();
    }
  });

  test('with nothing set aside, there is no Set aside line', async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      expect(container.querySelector('section[aria-labelledby="set-aside-heading"]')).toBeNull();
    } finally {
      await unmount();
    }
  });

  test('the highlight clears after its time even when a refetch that moves nothing follows', async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      const moved = PAGE.items.map(item =>
        item.item.key === '6' ? { ...realItem('8'), item: item.item } : item
      );
      await act(async () => {
        set(K.factoryItems(ID), { items: moved, members: {} });
      });
      // A second read right after, as several node events bring while checks start.
      await act(async () => {
        set(K.factoryItems(ID), { items: structuredClone(moved), members: {} });
      });
      expect(container.querySelector('[data-moved="true"]')).not.toBeNull();
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 1600));
      });
      expect(container.querySelector('[data-moved]')).toBeNull();
    } finally {
      await unmount();
    }
  });

  test('a refetch that moves a card marks it moved; one that does not, does not', async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      expect(container.querySelector('[data-moved]')).toBeNull();
      // Item 6 starts its deliver run: Build, then Checks once its review runs.
      const delivering = realItem('8');
      const moved = PAGE.items.map(item =>
        item.item.key === '6' ? { ...delivering, item: item.item } : item
      );
      await act(async () => {
        set(K.factoryItems(ID), { items: moved, members: {} });
      });
      const marked = [...container.querySelectorAll('[data-moved="true"]')].map(
        card => card.querySelector('.font-mono')?.textContent
      );
      expect(marked).toEqual(['#6']);
    } finally {
      await unmount();
    }
  });
});

describe('an item waiting on you with no ask open', () => {
  test('its card reads its label, soft, lists its questions and does not ping; so does its row', async () => {
    const item = needsShaping('9s', ['Which surfaces?', 'Who owns it?']);
    const board = await mount([item]);
    try {
      const card = board.container.querySelector('[data-card="9s"]');
      expect(card?.textContent).toContain('Needs shaping');
      // The first question on its line, and the count beside it, never clamped away.
      expect(card?.textContent).toContain('Which surfaces?2 questions');
      expect(card?.querySelector('[data-ping]')).toBeNull();
      const pill = [...(card?.querySelectorAll('span') ?? [])].find(
        span => span.textContent === 'Needs shaping'
      );
      expect(pill?.className).toContain('bg-[color:var(--warning-soft)]');
      expect(pill?.className).not.toContain('bg-warning ');
    } finally {
      await board.unmount();
    }
    const table = await mount([item], `/console/p/${ID}/factory/board?view=table`);
    try {
      const row = table.container.querySelector('tbody');
      expect(row?.textContent).toContain('Needs shaping');
      // The count stands apart from the clamped question, as on the card, and is on hover too.
      const count = row?.querySelector('[data-stop-count]');
      expect(count?.textContent).toBe('2 questions');
      expect(count?.parentElement?.getAttribute('title')).toBe('Which surfaces? · 2 questions');
      expect(count?.parentElement?.className).not.toContain('line-clamp');
    } finally {
      await table.unmount();
    }
  });
});

describe('the Table view', () => {
  test('one row per item; a header click sorts by that field', async () => {
    const { container, unmount } = await mount(
      PAGE.items,
      `/console/p/${ID}/factory/board?view=table`
    );
    try {
      const keys = (): string[] =>
        [...container.querySelectorAll('tbody tr')].map(row => row.getAttribute('data-card') ?? '');
      // Board order: left to right, then the order the page lists them.
      expect(keys()).toEqual(['5', '4', '6', '3', '8', '7', '2', '1']);
      const header = (label: string): HTMLButtonElement =>
        [...container.querySelectorAll('th button')].find(button =>
          button.textContent?.startsWith(label)
        ) as HTMLButtonElement;
      const firstRow = container.querySelector('tbody tr');
      expect(firstRow?.querySelector('a')?.getAttribute('href')).toBe(
        `/console/p/${ID}/factory/items/5`
      );
      await act(async () => header('Item').click());
      expect(keys()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
      await act(async () => header('Item').click());
      expect(keys()).toEqual(['8', '7', '6', '5', '4', '3', '2', '1']);
      await act(async () => header('Returned').click());
      expect(keys()).toEqual(['5', '4', '6', '8', '7', '3', '2', '1']);
    } finally {
      await unmount();
    }
  });

  test('the Merged cell is short, the full local time on hover', async () => {
    const { container, unmount } = await mount(
      PAGE.items,
      `/console/p/${ID}/factory/board?view=table`
    );
    try {
      const at = realItem('7').progress!.change!.mergedAt!;
      const column = [...container.querySelectorAll('thead th')].findIndex(th =>
        th.textContent?.startsWith('Merged')
      );
      const cell = [...container.querySelectorAll('tbody tr')]
        .find(row => row.getAttribute('data-card') === '7')
        ?.querySelectorAll('td')[column];
      // Short on its own terms, not by the function the cell renders: no year, no seconds,
      // and shorter than the full time. The Table fits 1440x900 only while this holds.
      const text = cell?.textContent ?? '';
      const year = new Date(at).getFullYear().toString();
      expect(text).not.toContain(year);
      expect(text).toMatch(/ \d{2}:\d{2}$/);
      expect(text.length).toBeLessThan(formatDateTime(at).length);
      expect(text.length).toBeLessThanOrEqual(14);
      expect(cell?.querySelector('[title]')?.getAttribute('title')).toBe(formatDateTime(at));
    } finally {
      await unmount();
    }
  });

  test("the Work order cell sits under its header and links to the order's page", async () => {
    const items = PAGE.items.map(item =>
      item.item.key === '5' ? { ...item, progress: { ...item.progress!, partOf: '48' } } : item
    );
    const { container, unmount } = await mount(items, `/console/p/${ID}/factory/board?view=table`);
    try {
      const column = [...container.querySelectorAll('thead th')].findIndex(th =>
        th.textContent?.startsWith('Work order')
      );
      expect(column).toBeGreaterThan(-1);
      const cell = (key: string) =>
        [...container.querySelectorAll('tbody tr')]
          .find(row => row.getAttribute('data-card') === key)
          ?.querySelectorAll('td')[column];
      expect(cell('5')?.textContent).toBe('#48');
      expect(cell('5')?.querySelector('a')?.getAttribute('href')).toBe(
        `/console/p/${ID}/factory/items/48`
      );
      expect(cell('4')?.textContent).toBe('');
    } finally {
      await unmount();
    }
  });
});

describe('a board opened from a number', () => {
  test('?show=landed with the Table view: only landed rows; Show all brings back the rest', async () => {
    const { container, unmount } = await mount(
      PAGE.items,
      `/console/p/${ID}/factory/board?show=landed&view=table`
    );
    try {
      const keys = (): string[] =>
        [...container.querySelectorAll('tbody tr')].map(row => row.getAttribute('data-card') ?? '');
      expect(keys()).toEqual(['7', '2', '1']);
      expect(container.textContent).toContain('Showing: merged');
      const clear = container.querySelector(
        'button[aria-label="Show every item"]'
      ) as HTMLButtonElement;
      await act(async () => clear.click());
      expect(keys()).toEqual(['5', '4', '6', '3', '8', '7', '2', '1']);
      expect(container.textContent).not.toContain('Showing:');
    } finally {
      await unmount();
    }
  });

  const rowKeys = (container: HTMLElement, selector = 'tbody tr'): string[] =>
    [...container.querySelectorAll(selector)].map(row => row.getAttribute('data-card') ?? '');
  const model = () => boardModel(VIEW, ID, PAGE.items, new Map(), FIXTURE_NOW);

  test('"N of M merged": the Table of every item on the board, the merged ones marked', async () => {
    const { container, unmount } = await mount(
      PAGE.items,
      `/console/p/${ID}/factory/board?view=table&show=landed-of-all`
    );
    try {
      const { landed, total } = factoryNumbers(model(), NOW);
      expect(rowKeys(container)).toHaveLength(total);
      expect(rowKeys(container, 'tbody tr[data-mark="landed"]')).toHaveLength(landed);
      expect(rowKeys(container, 'tbody tr[data-mark="landed"]')).toEqual(['7', '2', '1']);
      expect(container.textContent).toContain('Showing: every item, merged ones marked');
      const clear = container.querySelector(
        'button[aria-label="Show every item"]'
      ) as HTMLButtonElement;
      await act(async () => clear.click());
      // Still the Table, unmarked; the folded ending is back.
      expect(container.querySelector('table')).not.toBeNull();
      expect(container.querySelector('tr[data-mark]')).toBeNull();
      expect(container.textContent).not.toContain('Showing:');
    } finally {
      await unmount();
    }
  });

  test('the median: merged rows by time to merge, the median row marked, the number checkable', async () => {
    const { container, unmount } = await mount(
      PAGE.items,
      `/console/p/${ID}/factory/board?view=table&show=median-to-land`
    );
    try {
      const placed = new Map(
        model()
          .columns.flatMap(column => column.cards)
          .map(card => [card.card.key, card])
      );
      const times = rowKeys(container).map(key => {
        const card = placed.get(key);
        return card === undefined ? null : timeToLand(card);
      });
      expect(times.length).toBeGreaterThan(1);
      // Ascending; a row with no time to merge after every time.
      const known = times.filter((time): time is number => time !== null);
      expect(known).toEqual([...known].sort((a, b) => a - b));
      expect(times.slice(known.length).every(time => time === null)).toBe(true);
      const marked = rowKeys(container, 'tbody tr[data-mark="median"]');
      expect(marked.length).toBeGreaterThan(0);
      const markedTimes = marked.map(key => timeToLand(placed.get(key)!) ?? NaN);
      const mean = markedTimes.reduce((sum, time) => sum + time, 0) / markedTimes.length;
      expect(mean).toBe(factoryNumbers(model(), NOW).medianToLandMs!);
      expect(container.querySelector('th[aria-sort="ascending"]')?.textContent).toContain(
        'To merge'
      );
      expect(container.querySelector('tr[data-mark="median"]')?.textContent).toContain('Median');
      expect(container.textContent).toContain('Showing: merged, by time to merge, median marked');
    } finally {
      await unmount();
    }
  });

  test('found by the factory: the whole board, the strips open, their line scrolled to once', async () => {
    const scrolled: Element[] = [];
    const proto = dom.HTMLElement.prototype as unknown as {
      scrollIntoView: (this: Element, options?: unknown) => void;
    };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element): void {
      scrolled.push(this);
    };
    const closed = endLastRun(keepRuns(realItem('6'), 1), 'completed', 'fold');
    const { container, unmount } = await mount(
      [closed, ...PAGE.items.filter(item => item.item.key !== '6')],
      `/console/p/${ID}/factory/board?show=found`
    );
    try {
      expect(cardKeys(container)).toHaveLength(PAGE.items.length - 1);
      // Nothing narrowed: the set-aside line stays, as a show that narrows would hide it.
      expect(container.querySelector('#set-aside-heading')?.textContent).toBe('1 set aside');
      // The one toggle's state opened both strips.
      expect(stripsToggle(container)?.textContent).toBe('hide them');
      expect(container.querySelector('#found-by-the-factory-list')).not.toBeNull();
      expect(container.querySelector('#set-aside-list')).not.toBeNull();
      expect(container.textContent).toContain('Showing: found by the factory');
      // The line, not the findings: it holds both names, the shadow badge and the toggle.
      // By identity: a failing toEqual on a happy-dom Element hangs bun while it formats the diff.
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0] === container.querySelector('[data-board-strips]')).toBe(true);
      expect(scrolled[0]?.querySelector('#found-by-the-factory-heading')).not.toBeNull();
      expect(scrolled[0]?.textContent).toContain('shadow');
      // A view switch rewrites the address; it must not scroll the page away from the board.
      await act(async () => viewButton(container, 'Table').click());
      await act(async () => viewButton(container, 'Pipeline').click());
      // Nor does closing and reopening: the person asked for the strips, not to be moved.
      await act(async () => stripsToggle(container)?.click());
      await act(async () => stripsToggle(container)?.click());
      expect(container.querySelector('#found-by-the-factory-list')).not.toBeNull();
      expect(scrolled).toHaveLength(1);
    } finally {
      await unmount();
      proto.scrollIntoView = original;
    }
  });

  test('an unknown ?show= says so and filters nothing', async () => {
    const { container, unmount } = await mount(
      PAGE.items,
      `/console/p/${ID}/factory/board?show=bogus`
    );
    try {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Unknown filter "bogus"'
      );
      expect(cardKeys(container)).toHaveLength(PAGE.items.length);
    } finally {
      await unmount();
    }
  });
});

describe('while a merge state is pending', () => {
  test('Ready to merge and Merged show a skeleton count; the card says why', async () => {
    const { container, unmount } = await mount([...PAGE.items, readyWithMerge('p', 'pending')]);
    try {
      const shown = headers(container);
      expect(shown).toContain('Ready to mergechecking');
      expect(shown).toContain('Mergedchecking');
      expect(shown).toContain('Plan & build4');
      const ready = columnNamed(container, 'Ready to merge');
      expect(ready?.textContent).toContain('checking merge state');
      // No state chips while the count is not known: they would count what the skeleton hides.
      expect(ready?.querySelectorAll('header li')).toHaveLength(0);
    } finally {
      await unmount();
    }
  });

  test('an empty column whose count is not known shows card skeletons, not "Nothing in"', async () => {
    // Nothing merged is read yet and one change waits on its answer: Merged may gain it.
    const { container, unmount } = await mount([realItem('6'), readyWithMerge('p', 'pending')]);
    try {
      const merged = columnNamed(container, 'Merged');
      expect(merged?.querySelector('[data-skeleton]')).not.toBeNull();
      expect(merged?.textContent).not.toContain('Nothing in');
    } finally {
      await unmount();
    }
  });
});

test('a failed refresh says so and keeps the board it last read', async () => {
  const { container, unmount } = await mount(PAGE.items);
  try {
    // The refresh fetches, which this file's fetch refuses.
    await act(async () => invalidate(K.factoryItems(ID)));
    for (let turn = 0; turn < 5 && container.querySelector('[role="status"]') === null; turn++)
      await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Could not refresh: the board test fetched. Showing the last values read.'
    );
    expect(headers(container)).toContain('Merged3');
  } finally {
    await unmount();
  }
});

/** Real item 7 (merged) keyed `key`, merged at `at`. */
function mergedOn(key: string, at: Date): FactoryItem {
  const item = realItem('7');
  item.item = { ...item.item, key };
  item.progress = {
    ...item.progress!,
    change: { ...item.progress!.change!, mergedAt: at.toISOString() },
  };
  return item;
}

describe('the column headers and the Merged column', () => {
  test("a header names its column, its stages and its cards' states", async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      const header = columnNamed(container, 'Plan & build')?.querySelector('header');
      expect(header?.querySelector('p')?.textContent).toBe('Plan, build');
      expect([...(header?.querySelectorAll('li') ?? [])].map(chip => chip.textContent)).toEqual([
        'running 2',
        'waiting 2',
      ]);
    } finally {
      await unmount();
    }
  });

  test('Merged lists the last 7 days newest first, and links to the Table for the rest', async () => {
    const items = [
      ...PAGE.items,
      mergedOn('old', new Date(2026, 10, 8, 9)),
      mergedOn('older', new Date(2026, 9, 1)),
    ];
    const { container, unmount } = await mount(items);
    try {
      const merged = columnNamed(container, 'Merged');
      expect(merged?.querySelector('header p')?.textContent).toBe('last 7 days');
      expect(headers(container)).toContain('Merged3');
      expect(cardKeys(merged as HTMLElement)).toEqual(['7', '2', '1']);
      const earlier = [...(merged?.querySelectorAll('a') ?? [])].find(link =>
        link.textContent?.includes('earlier')
      );
      expect(earlier?.textContent).toBe('2 earlier · show all');
      expect(earlier?.getAttribute('href')).toBe(
        `/console/p/${ID}/factory/board?view=table&show=landed`
      );
      // A merged card is compact: its change and when it merged, no round, no returned count.
      const seven = [...(merged?.querySelectorAll('article') ?? [])].find(
        article => article.getAttribute('data-card') === '7'
      );
      const change = realItem('7').progress!.change!;
      expect(seven?.textContent).toContain(formatDateTime(change.mergedAt!));
      expect(seven?.querySelector(`a[href="${change.url}"]`)?.textContent).toBe(
        `PR #${String(change.number)}`
      );
      expect(merged?.textContent).not.toContain('round');
      expect(merged?.textContent).not.toContain('returned');
    } finally {
      await unmount();
    }
  });

  test('an empty column says so', async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      expect(columnNamed(container, 'Intake')?.textContent).toContain('Nothing in Intake now');
    } finally {
      await unmount();
    }
  });

  test('a column a filter empties says no card matches, never that it is empty', async () => {
    // Plan & build holds 4 items; none needs you.
    const { container, unmount } = await mount(
      PAGE.items,
      `/console/p/${ID}/factory/board?show=needs-you`
    );
    try {
      const column = columnNamed(container, 'Plan & build')?.textContent ?? '';
      expect(column).toContain('No card here matches the filter');
      expect(column).not.toContain('Nothing in');
    } finally {
      await unmount();
    }
  });

  test('the filter box counts as a filter: a column it empties says no card matches', async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      await filterTo(container, 'needs you');
      const column = columnNamed(container, 'Plan & build')?.textContent ?? '';
      expect(column).toContain('No card here matches the filter');
      expect(column).not.toContain('Nothing in');
    } finally {
      await unmount();
    }
  });

  test('a filtered Merged column whose matches all merged earlier points to them', async () => {
    const { container, unmount } = await mount([
      mergedOn('old', new Date(2026, 10, 8, 9)),
      mergedOn('older', new Date(2026, 9, 1)),
      realItem('7'),
    ]);
    try {
      await filterTo(container, 'old');
      const merged = columnNamed(container, 'Merged')?.textContent ?? '';
      expect(merged).toContain('No match merged in the last 7 days');
      expect(merged).not.toContain('No card here matches');
      expect(merged).toContain('2 earlier');
    } finally {
      await unmount();
    }
  });

  test('a Merged column with only older merges says none in the last 7 days', async () => {
    const { container, unmount } = await mount([
      mergedOn('old', new Date(2026, 10, 8, 9)),
      mergedOn('older', new Date(2026, 9, 1)),
    ]);
    try {
      const merged = columnNamed(container, 'Merged')?.textContent ?? '';
      expect(merged).toContain('Nothing merged in the last 7 days');
      expect(merged).not.toContain('Nothing in');
      expect(merged).toContain('2 earlier');
    } finally {
      await unmount();
    }
  });

  test('stacked on a phone, a column shows 3 cards and "show all N" for the rest', async () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map(key => ({
      ...realItem('6'),
      item: { ...realItem('6').item, key },
    }));
    const { container, unmount } = await mount(five);
    try {
      const column = columnNamed(container, 'Plan & build');
      const folded = () => column?.querySelectorAll('.max-md\\:hidden').length;
      expect(folded()).toBe(2);
      const button = [...(column?.querySelectorAll('button') ?? [])].find(
        b => b.textContent === 'show all 5'
      );
      expect(button).toBeDefined();
      await act(async () => button?.click());
      expect(folded()).toBe(0);
    } finally {
      await unmount();
    }
  });
});

/** Type `query` into the board's filter box, as a keystroke does. */
async function filterTo(container: HTMLElement, query: string): Promise<void> {
  const input = container.querySelector('input[type="search"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter?.call(input, query);
    input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  });
}

describe('a column body', () => {
  test('a waiting card names the stage it waits in', async () => {
    const { container, unmount } = await mount(PAGE.items);
    try {
      const card = [
        ...(columnNamed(container, 'Plan & build')?.querySelectorAll('article') ?? []),
      ].find(article => article.querySelector('.font-mono')?.textContent === '#6');
      expect(card?.textContent).toContain('Build');
      expect(card?.querySelector('a[href*="/r/"]')).toBeNull();
    } finally {
      await unmount();
    }
  });

  test('the bottom fade follows the cards a filter leaves, not only scrolling', async () => {
    // happy-dom lays nothing out: a column body is 250 px tall, 100 px per child.
    const proto = dom.HTMLElement.prototype as unknown as HTMLElement;
    const saved = ['scrollHeight', 'clientHeight'].map(
      key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const
    );
    const sized = (value: (body: HTMLElement) => number) => ({
      configurable: true,
      get(this: HTMLElement): number {
        return this.dataset.columnBody === undefined ? 0 : value(this);
      },
    });
    Object.defineProperty(
      proto,
      'scrollHeight',
      sized(body => body.children.length * 100)
    );
    Object.defineProperty(
      proto,
      'clientHeight',
      sized(() => 250)
    );
    const { container, unmount } = await mount(PAGE.items);
    try {
      const fade = () => columnNamed(container, 'Merged')?.querySelector('[data-fade]');
      expect(fade()).not.toBeNull();
      await filterTo(container, '7');
      expect(fade()).toBeNull();
      await filterTo(container, '');
      expect(fade()).not.toBeNull();
    } finally {
      await unmount();
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else Reflect.deleteProperty(proto, key);
    }
  });
});

test("the Table puts each row's column and stage under the Column and Stage headers", async () => {
  const { container, unmount } = await mount(
    PAGE.items,
    `/console/p/${ID}/factory/board?view=table`
  );
  try {
    const headers = [...container.querySelectorAll('thead th')].map(th =>
      (th.textContent ?? '').replace(/ [↑↓]$/, '')
    );
    const column = headers.indexOf('Column');
    const stage = headers.indexOf('Stage');
    expect(stage).toBe(column + 1);
    const cells = (key: string): string[] =>
      [
        ...([...container.querySelectorAll('tbody tr')]
          .find(row => row.getAttribute('data-card') === key)
          ?.querySelectorAll('td') ?? []),
      ].map(td => td.textContent ?? '');
    // A merged row's Stage is empty: its Column and State already say merged.
    expect([cells('7')[column], cells('7')[stage]]).toEqual(['Merged', '']);
    // A running item's step folds into its Stage cell, as the card's stage line reads.
    expect(headers).not.toContain('Running step');
    expect([cells('8')[column], cells('8')[stage]]).toEqual([
      'Checks & review',
      'ChecksProduct check · round 1',
    ]);
    // A cell after them still sits under its own header.
    expect(cells('7')[headers.indexOf('State')]).toBe('Merged');
  } finally {
    await unmount();
  }
});

describe('an issue key on the board', () => {
  /** Item 7 of the fixture page, keyed as a pack revision keys it. */
  const keyed = (key: string): FactoryItem => {
    const item = realItem('7');
    return { ...item, item: { ...item.item, key } };
  };

  test('`issue-7` and `7` both read #7 on the card, which still opens the item under its key', async () => {
    for (const key of ['issue-7', '7']) {
      const { container, unmount } = await mount([keyed(key)]);
      try {
        const article = container.querySelector(`article[data-card="${key}"]`);
        expect(article?.querySelector('.font-mono')?.textContent).toBe('#7');
        expect(article?.querySelector('a[href*="/items/"]')?.getAttribute('href')).toBe(
          `/console/p/${ID}/factory/items/${key}`
        );
      } finally {
        await unmount();
      }
    }
  });

  test('`issue-7` and `7` both read #7 in the Table, whose link keeps the key', async () => {
    for (const key of ['issue-7', '7']) {
      const { container, unmount } = await mount(
        [keyed(key)],
        `/console/p/${ID}/factory/board?view=table`
      );
      try {
        const link = container.querySelector(`tbody tr[data-card="${key}"] td a`);
        expect(link?.textContent).toBe('#7');
        expect(link?.getAttribute('href')).toBe(`/console/p/${ID}/factory/items/${key}`);
      } finally {
        await unmount();
      }
    }
  });

  /** Item 7 keyed as a split member of `issue-136`, through its order run's result. */
  const member = (): FactoryItem => {
    const item = keyed('issue-136-item-keys');
    return { ...item, progress: { ...item.progress!, partOf: 'issue-136' } };
  };

  test("a split member's card reads #136 · item keys and still opens the item under its key", async () => {
    const { container, unmount } = await mount([member()]);
    try {
      const article = container.querySelector('article[data-card="issue-136-item-keys"]');
      expect(article?.querySelector('.font-mono')?.textContent).toBe('#136 · item keys');
      expect(article?.querySelector('a[href*="/items/"]')?.getAttribute('href')).toBe(
        `/console/p/${ID}/factory/items/issue-136-item-keys`
      );
    } finally {
      await unmount();
    }
  });

  test("a split member's Table row reads #136 · item keys on one line, whose link keeps the key", async () => {
    const { container, unmount } = await mount(
      [member()],
      `/console/p/${ID}/factory/board?view=table`
    );
    try {
      const link = container.querySelector('tbody tr[data-card="issue-136-item-keys"] td a');
      expect(link?.textContent).toBe('#136 · item keys');
      // A key never breaks inside itself: the title beside it wraps instead (#146).
      expect(link?.classList.contains('whitespace-nowrap')).toBe(true);
      expect(link?.getAttribute('href')).toBe(`/console/p/${ID}/factory/items/issue-136-item-keys`);
    } finally {
      await unmount();
    }
  });
});
