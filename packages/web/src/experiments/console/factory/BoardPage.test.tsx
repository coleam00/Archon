import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { installDom } from '../test-dom.test-helpers';
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
} from './lib/board.test-fixtures';
import { DISCOVERIES } from './lib/discoveries.test-fixtures';
import { boardColumns } from './lib/board-columns';
import { cancelRereads } from './merge-reread';
import { cancelMergeWatches } from './merge-watch';
import { formatDateTime } from '../lib/format';

// Filtering, sorting, the strips and the move highlight follow a re-render, which static markup
// cannot reach. The rules behind each check are tested in lib/ (board, placement, set-aside,
// board-table, work-orders); these scenarios check that the board shows their result.
const { dom, mount: render, settle } = await installDom();

const ID = 'cb-1';
// The Merged column lists the last 7 local days; the fixtures merged on 2026-11-17.
const NOW = new Date(2026, 10, 18, 12, 0);
const DAY = 24 * 60 * 60 * 1000;
// Both share project cb-1: a reread or merge watch left running would land in the next test.
afterEach(() => {
  cancelRereads();
  cancelMergeWatches();
  invalidate('factory-items');
});

/** `board` under a project queue where nothing waits on a person: asks are BoardAsks.test.tsx's. */
function quiet(board: ReactElement): ReactElement {
  set(K.projectAttention(ID), { items: [], runs: [], degraded: [] });
  return <ProjectAttentionProvider projectId={ID}>{board}</ProjectAttentionProvider>;
}

async function mount(
  items: FactoryItem[],
  path = `/console/p/${ID}/factory/board`,
  members: Record<string, string[]> = {}
) {
  set(K.factoryItems(ID), { items, members });
  // The view declares discoveries, so the board mounts the "Found by the factory" panel.
  set(K.factoryDiscoveries(ID), DISCOVERIES);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/console/p/:projectId/factory/board"
          element={quiet(<Board projectId={ID} view={VIEW} now={NOW} />)}
        />
      </Routes>
    </MemoryRouter>
  );
}

/** Each column's label and count, as its header shows them ("checking" while it waits). */
const headers = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('header[data-column]')].map(
    header =>
      `${header.querySelector('h3')?.textContent ?? ''}${header.querySelector('[data-count]')?.textContent ?? ''}`
  );
const columnNamed = (container: HTMLElement, label: string): Element | null =>
  container.querySelector(`section[aria-label="${label}"]`);
const cardKeys = (container: ParentNode): string[] =>
  [...container.querySelectorAll('article')].map(card => card.getAttribute('data-card') ?? '');
const card = (container: HTMLElement, key: string): Element | null =>
  container.querySelector(`article[data-card="${key}"]`);
const rowKeys = (container: HTMLElement, selector = 'tbody tr'): string[] =>
  [...container.querySelectorAll(selector)].map(row => row.getAttribute('data-card') ?? '');
const stripsToggle = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector('[data-board-strips] > button');
const button = (container: ParentNode, label: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find(
    candidate => candidate.textContent === label
  ) as HTMLButtonElement;

/** Type `query` into the board's filter box, as a keystroke does. */
async function filterTo(container: HTMLElement, query: string): Promise<void> {
  const input = container.querySelector('input[type="search"]') as HTMLInputElement;
  await act(async () => {
    // React listens for the native input event; set the value the way a keystroke does.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter?.call(input, query);
    input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  });
}

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

test('before the items are read: a skeleton column per declared column, no "Loading…"', async () => {
  // A read that never answers: the board stays in its loading state.
  const answering = globalThis.fetch;
  globalThis.fetch = Object.assign(async (): Promise<Response> => new Promise(() => {}), {
    preconnect: answering.preconnect,
  });
  set(K.factoryDiscoveries(ID), DISCOVERIES);
  const { container, unmount } = await render(
    <MemoryRouter initialEntries={[`/console/p/${ID}/factory/board`]}>
      {quiet(<Board projectId={ID} view={VIEW} now={NOW} />)}
    </MemoryRouter>
  );
  try {
    expect(headers(container)).toEqual(boardColumns(VIEW).map(column => `${column.label}loading`));
    expect(container.querySelectorAll('[data-skeleton="block"]').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('…');
  } finally {
    await unmount();
    globalThis.fetch = answering;
  }
});

test('the Pipeline: columns, cards, work orders, the strips under the board, a failed refresh', async () => {
  // PAGE without its item 6, which comes back folded into another item; 5 and 2 are part of
  // work order 48 (9 is linked and has no run), 4 is part of 8, an order with runs.
  const orders: Record<string, string> = { '5': '48', '2': '48', '4': '8' };
  const items = [
    ...PAGE.items.filter(item => item.item.key !== '6'),
    endLastRun(keepRuns(realItem('6'), 1), 'completed', 'fold'),
    idleInPlan('i', new Date(NOW.getTime() - 4 * DAY).toISOString()),
    parkedByTriage('p'),
  ].map(item =>
    item.item.key in orders
      ? { ...item, progress: { ...item.progress!, partOf: orders[item.item.key]! } }
      : item
  );
  const { container, unmount } = await mount(items, undefined, { '48': ['9'] });
  try {
    expect(headers(container)).toEqual([
      'Intake0',
      'Plan & build3',
      'Checks & review1',
      'Ready to merge0',
      'Merged3',
    ]);
    expect(columnNamed(container, 'Intake')?.textContent).toContain('Nothing in Intake now');
    // A running card names its step and links its item and its run.
    const checks = columnNamed(container, 'Checks & review');
    expect(
      checks?.querySelector('a[aria-label="Checks · Product check · round 1"]')
    ).not.toBeNull();
    expect(checks?.querySelector(`a[href="/console/p/${ID}/factory/items/8"]`)).not.toBeNull();
    expect(checks?.querySelector('a[href^="/console/p/cb-1/r/"]')).not.toBeNull();
    // A merged card is compact: its change and when it merged, no round, no returned count.
    const change = realItem('7').progress!.change!;
    expect(card(container, '7')?.textContent).toContain(formatDateTime(change.mergedAt!));
    expect(card(container, '7')?.querySelector(`a[href="${change.url}"]`)?.textContent).toBe(
      `PR #${String(change.number)}`
    );
    expect(columnNamed(container, 'Merged')?.textContent).not.toMatch(/round|returned/);

    // The work orders: open above the columns, one row per order, a chip on each member.
    const row = container.querySelector('ul[aria-label="Work orders"] li[data-order="48"]');
    expect(row?.textContent).toContain('1 of 3 merged');
    expect(row?.querySelector('a')?.getAttribute('href')).toBe(`/console/p/${ID}/factory/items/48`);
    expect(
      [...(row?.querySelectorAll('[role="img"][title]') ?? [])].map(dot =>
        dot.getAttribute('title')
      )
    ).toEqual(['#5: Running', '#2: Merged', '#9: Waiting']);
    expect(card(container, '5')?.querySelector('a[href$="?order=48"]')?.textContent).toBe(
      'part of #48'
    );
    // Lighting an order dims every other card, named on the header line until cleared.
    await act(async () =>
      (row?.querySelector('button[aria-pressed]') as HTMLButtonElement).click()
    );
    const cards = cardKeys(container).length;
    expect(container.querySelectorAll('article[data-dimmed="true"]')).toHaveLength(cards - 2);
    expect(container.textContent).toContain('highlighting #48');
    await act(async () => button(container, 'Clear highlight').click());
    expect(container.textContent).not.toContain('highlighting');
    expect(container.querySelectorAll('article[data-dimmed="true"]')).toHaveLength(0);

    // One line under the board, closed: Found by the factory and what was set aside.
    expect(container.querySelector('#found-by-the-factory-heading')?.textContent).toBe(
      'Found by the factory'
    );
    expect(container.querySelector('#set-aside-heading')?.textContent).toBe('3 set aside');
    expect(card(container, 'p')).toBeNull();
    expect(container.querySelector('#set-aside-list')).toBeNull();
    // One toggle opens both, each set-aside row with why.
    await act(async () => stripsToggle(container)?.click());
    expect(stripsToggle(container)?.textContent).toBe('hide them');
    expect(container.querySelector('#found-by-the-factory-list')).not.toBeNull();
    const reasons = container.querySelector('#set-aside-list')?.textContent ?? '';
    for (const why of ['Parked by triage', 'No change was proposed', 'Folded into another item'])
      expect(reasons).toContain(why);
    expect(
      container.querySelector('#set-aside-list a[href$="/factory/items/6"]')?.textContent
    ).toBe('#6');
    // Switching to the Table and back leaves the strips open.
    await act(async () => button(container, 'Table').click());
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('#set-aside-list')).not.toBeNull();
    await act(async () => button(container, 'Pipeline').click());
    expect(stripsToggle(container)?.textContent).toBe('hide them');

    // A refresh that fails says so and keeps the board it last read.
    await act(async () => invalidate(K.factoryItems(ID)));
    for (let turn = 0; turn < 5 && container.querySelector('[role="status"]') === null; turn++)
      await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Could not refresh');
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Showing the last values read.'
    );
    expect(headers(container)).toContain('Merged3');
  } finally {
    await unmount();
  }
});

describe('filters and re-reads', () => {
  test('the Merged window, the filter box, a waiting card and its column header', async () => {
    const items = [
      ...PAGE.items,
      mergedOn('old', new Date(2026, 10, 8, 9)),
      mergedOn('older', new Date(2026, 9, 1)),
    ];
    const { container, unmount } = await mount(items);
    try {
      const merged = columnNamed(container, 'Merged');
      expect(merged?.querySelector('header p')?.textContent).toBe('last 7 days');
      expect(cardKeys(merged!)).toEqual(['7', '2', '1']);
      const earlier = [...(merged?.querySelectorAll('a') ?? [])].find(link =>
        link.textContent?.includes('earlier')
      );
      expect(earlier?.textContent).toBe('2 earlier · show all');
      expect(earlier?.getAttribute('href')).toBe(
        `/console/p/${ID}/factory/board?view=table&show=landed`
      );
      // A header names its stages and its cards' states; a waiting card names its stage.
      const plan = columnNamed(container, 'Plan & build');
      expect(plan?.querySelector('header p')?.textContent).toBe('Plan, build');
      expect(
        [...(plan?.querySelectorAll('header li') ?? [])].map(chip => chip.textContent)
      ).toEqual(['running 2', 'waiting 2']);
      expect(card(container, '6')?.textContent).toContain('Build');
      expect(card(container, '6')?.querySelector('a[href*="/r/"]')).toBeNull();

      // The filter narrows the cards; a column it empties says no card matches.
      await filterTo(container, 'needs you');
      expect(cardKeys(container)).toEqual(['7']);
      expect(columnNamed(container, 'Plan & build')?.textContent).toContain(
        'No card here matches the filter'
      );
      // A Merged column whose matches all merged earlier points to them.
      await filterTo(container, 'old');
      expect(columnNamed(container, 'Merged')?.textContent).toContain(
        'No match merged in the last 7 days'
      );
    } finally {
      await unmount();
    }
  });

  test('while a merge state is pending, Ready and Merged say checking, and so does the card', async () => {
    const { container, unmount } = await mount([...PAGE.items, readyWithMerge('p', 'pending')]);
    try {
      expect(headers(container)).toEqual(
        expect.arrayContaining(['Ready to mergechecking', 'Mergedchecking', 'Plan & build4'])
      );
      expect(columnNamed(container, 'Ready to merge')?.textContent).toContain(
        'checking merge state'
      );
    } finally {
      await unmount();
    }
  });
});

test('the Table: row order and sorting, Column and Stage, Merged and Work order cells', async () => {
  const items = PAGE.items.map(item =>
    item.item.key === '5' ? { ...item, progress: { ...item.progress!, partOf: '48' } } : item
  );
  const table = await mount(items, `/console/p/${ID}/factory/board?view=table`);
  try {
    const { container } = table;
    // Board order: left to right, then the order the page lists them.
    expect(rowKeys(container)).toEqual(['5', '4', '6', '3', '8', '7', '2', '1']);
    expect(container.querySelector('tbody tr a')?.getAttribute('href')).toBe(
      `/console/p/${ID}/factory/items/5`
    );
    const header = (label: string): HTMLButtonElement =>
      [...container.querySelectorAll('th button')].find(candidate =>
        candidate.textContent?.startsWith(label)
      ) as HTMLButtonElement;
    await act(async () => header('Item').click());
    expect(rowKeys(container)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    await act(async () => header('Item').click());
    expect(rowKeys(container)).toEqual(['8', '7', '6', '5', '4', '3', '2', '1']);
    await act(async () => header('Returned').click());
    expect(rowKeys(container)).toEqual(['5', '4', '6', '8', '7', '3', '2', '1']);

    const titles = [...container.querySelectorAll('thead th')].map(th =>
      (th.textContent ?? '').replace(/ [↑↓]$/, '')
    );
    const cell = (key: string, title: string): Element | undefined =>
      container.querySelector(`tbody tr[data-card="${key}"]`)?.querySelectorAll('td')[
        titles.indexOf(title)
      ];
    // A merged row's Stage is empty; a running item's step folds into its Stage cell.
    expect(cell('7', 'Column')?.textContent).toBe('Merged');
    expect(cell('7', 'Stage')?.textContent).toBe('');
    expect(cell('8', 'Column')?.textContent).toBe('Checks & review');
    expect(cell('8', 'Stage')?.textContent).toBe('ChecksProduct check · round 1');
    expect(cell('7', 'State')?.textContent).toBe('Merged');
    // The Merged cell is short (no year, HH:MM), the full local time on hover.
    const at = realItem('7').progress!.change!.mergedAt!;
    const merged = cell('7', 'Merged');
    expect(merged?.textContent).not.toContain(new Date(at).getFullYear().toString());
    expect(merged?.textContent).toMatch(/ \d{2}:\d{2}$/);
    expect(merged?.querySelector('[title]')?.getAttribute('title')).toBe(formatDateTime(at));
    // The Work order cell links to the order's page.
    expect(cell('5', 'Work order')?.querySelector('a')?.getAttribute('href')).toBe(
      `/console/p/${ID}/factory/items/48`
    );
    expect(cell('5', 'Work order')?.textContent).toBe('#48');
    expect(cell('4', 'Work order')?.textContent).toBe('');
  } finally {
    await table.unmount();
  }

  // A split member reads under its order and keeps its key; a needs-shaping row counts questions.
  const member = realItem('7');
  member.item = { ...member.item, key: 'issue-136-item-keys' };
  member.progress = { ...member.progress!, partOf: 'issue-136' };
  const shaping = needsShaping('9s', ['Which surfaces?', 'Who owns it?']);
  const { container, unmount } = await mount(
    [member, shaping],
    `/console/p/${ID}/factory/board?view=table`
  );
  try {
    const link = container.querySelector('tbody tr[data-card="issue-136-item-keys"] td a');
    expect(link?.textContent).toBe('#136 · item keys');
    expect(link?.getAttribute('href')).toBe(`/console/p/${ID}/factory/items/issue-136-item-keys`);
    const shapingRow = container.querySelector('tbody tr[data-card="9s"]');
    expect(shapingRow?.textContent).toContain('Needs shaping');
    const count = shapingRow?.querySelector('[data-stop-count]');
    expect(count?.textContent).toBe('2 questions');
    expect(count?.parentElement?.getAttribute('title')).toBe('Which surfaces? · 2 questions');
  } finally {
    await unmount();
  }
});

describe('a board opened from a number', () => {
  test.each([
    ['show=landed&view=table', 'Showing: merged', ['7', '2', '1'], null],
    ['view=table&show=landed-of-all', 'Showing: every item, merged ones marked', null, 'landed'],
    [
      'view=table&show=median-to-land',
      'Showing: merged, by time to merge, median marked',
      null,
      'median',
    ],
  ] as const)(
    '?%s: its banner, its rows, and Show all clears it',
    async (query, banner, rows, mark) => {
      const { container, unmount } = await mount(
        PAGE.items,
        `/console/p/${ID}/factory/board?${query}`
      );
      try {
        expect(container.textContent).toContain(banner);
        if (rows !== null) expect(rowKeys(container)).toEqual([...rows]);
        if (mark === 'landed')
          expect(rowKeys(container, 'tbody tr[data-mark="landed"]')).toEqual(['7', '2', '1']);
        if (mark === 'median') {
          expect(container.querySelector('tr[data-mark="median"]')?.textContent).toContain(
            'Median'
          );
          expect(container.querySelector('th[aria-sort="ascending"]')?.textContent).toContain(
            'To merge'
          );
        }
        await act(async () =>
          (
            container.querySelector('button[aria-label="Show every item"]') as HTMLButtonElement
          ).click()
        );
        expect(container.querySelector('table')).not.toBeNull();
        expect(rowKeys(container)).toEqual(['5', '4', '6', '3', '8', '7', '2', '1']);
        expect(container.querySelector('tr[data-mark]')).toBeNull();
        expect(container.textContent).not.toContain('Showing:');
      } finally {
        await unmount();
      }
    }
  );

  test('?show=found: the whole board, both strips open, their line scrolled to once', async () => {
    const scrolled: Element[] = [];
    const proto = dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element): void {
      scrolled.push(this);
    };
    const closed = endLastRun(keepRuns(realItem('6'), 1), 'completed', 'fold');
    const rest = PAGE.items.filter(item => item.item.key !== '6');
    const { container, unmount } = await mount(
      [closed, ...rest],
      `/console/p/${ID}/factory/board?show=found`
    );
    try {
      expect(cardKeys(container)).toHaveLength(rest.length);
      expect(container.querySelector('#found-by-the-factory-list')).not.toBeNull();
      expect(container.querySelector('#set-aside-list')).not.toBeNull();
      // By identity: a failing toEqual on a happy-dom Element hangs bun while it formats the diff.
      expect(
        scrolled.length === 1 && scrolled[0] === container.querySelector('[data-board-strips]')
      ).toBe(true);
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
