/**
 * The Needs you tab mounted and pressed: a row opens and closes its ask section as its child, and
 * the filter bar's controls take the filter away, and a row whose asks were all answered stays
 * in place until dismissed. The static renders in
 * `ProjectNeedsYouPage.test.tsx` cover what a first paint shows.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { installDom } from '../factory/test-dom.test-helpers';
import type { ItemAsk } from '../primitives/run';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';

const { mount: mountTree } = await installDom();
// Loaded after the window exists: react-dom reads it when it loads.
const { ProjectNeedsYouPage } = await import('./ProjectNeedsYouPage');

function ask(ref: string, key: string): ItemAsk {
  return {
    kind: 'attention',
    ref,
    project: { key: 'acme/web', codebaseId: 'web', name: 'web' },
    item: { id: `id-${key}`, projectKey: 'acme/web', key },
    priority: false,
    revision: 1,
    labels: {},
    pausedAt: null,
    message: `Question on ${key}`,
    form: 'select',
    options: [{ id: 'land', label: 'Land it', does: 'Lands it.', cost: 'Nothing.' }],
    recommendation: { option: 'land', why: 'It fits.' },
  };
}

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  for (const prefix of ['projects', 'board', 'runs', 'forge-titles']) invalidate(prefix);
});

async function mount(
  path: string,
  asks: ItemAsk[] = [ask('ask:a', 'issue-198'), ask('ask:c', 'issue-200')]
): Promise<HTMLElement> {
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks,
    answerRefusals: {},
    // Every listed item is held open, as the server says, so Dismiss shows only once a refetch
    // has taken an item off the list.
    itemIds: new Set(asks.flatMap(listed => (listed.item === undefined ? [] : [listed.item.id]))),
    refs: new Set<string>(),
    degraded: [],
  });
  set(K.projects, []);
  set(K.boardOrders('web'), []);
  const mounted = await mountTree(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/console/p/:projectId/needs-you" element={<ProjectNeedsYouPage />} />
      </Routes>
    </MemoryRouter>
  );
  unmount = mounted.unmount;
  return mounted.container;
}

async function press(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
}

const rowsIn = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-needs-row]')]
    .map(row => row.getAttribute('data-item-key') ?? '')
    .sort();

test('a row header opens its ask section as the row child, and closes it again', async () => {
  const root = await mount('/console/p/web/needs-you');
  const row = root.querySelector('[data-item-key="issue-198"]');
  const header = row?.querySelector('button[aria-expanded]');
  expect(header?.getAttribute('aria-expanded')).toBe('false');
  expect(row?.querySelector('[data-needs-child]')).toBeNull();

  await press(header);
  expect(header?.getAttribute('aria-expanded')).toBe('true');
  const child = row?.querySelector('[data-needs-child]');
  expect(child?.querySelector('[data-ask-ref="ask:a"]')).not.toBeNull();
  expect(header?.getAttribute('aria-controls')).toBe(child?.id ?? 'missing');
  // The other row stays closed.
  expect(root.querySelector('[data-item-key="issue-200"] [data-needs-child]')).toBeNull();

  await press(header);
  expect(header?.getAttribute('aria-expanded')).toBe('false');
  expect(row?.querySelector('[data-needs-child]')).toBeNull();
});

test('Show all takes the filter away: every item shows and the bar goes', async () => {
  const root = await mount('/console/p/web/needs-you?item=198');
  expect(rowsIn(root)).toEqual(['issue-198']);
  await press(root.querySelector('[data-filter-clear]'));
  expect(rowsIn(root)).toEqual(['issue-198', 'issue-200']);
  expect(root.querySelector('[data-filter-bar]')).toBeNull();
});

test('removing one of two filters leaves the other in the bar', async () => {
  const root = await mount('/console/p/web/needs-you?item=198,200');
  expect(rowsIn(root)).toEqual(['issue-198', 'issue-200']);
  await press(root.querySelector('[data-item-filter="198"] a'));
  expect(rowsIn(root)).toEqual(['issue-200']);
  expect(root.querySelector('[data-item-filter="198"]')).toBeNull();
  expect(root.querySelector('[data-filter-bar] [data-item-filter="200"]')).not.toBeNull();
});

/**
 * Stubs the server for an answer to ask:a: the answer post succeeds, and the attention list it
 * refetches holds only ask:c. Any other request fails the test.
 */
function stubAnswerServer(): { gets: () => number; restore: () => void } {
  const originalFetch = globalThis.fetch;
  let attentionGets = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/attention/answer')
        return Response.json({ ref: 'ask:a', action: 'answer', unchanged: false, settled: false });
      if (path === '/api/runs/attention') {
        attentionGets += 1;
        return Response.json({ runs: [], items: [ask('ask:c', 'issue-200')], answerRefusals: {} });
      }
      throw new Error(`Unexpected request ${path}`);
    },
    { preconnect: originalFetch.preconnect }
  );
  return {
    gets: () => attentionGets,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** Answers ask:a from its open row, then waits until the refetched list (without it) is shown. */
async function answerAskA(root: HTMLElement, server: { gets: () => number }): Promise<void> {
  const row = root.querySelector('[data-item-key="issue-198"]');
  const header = row?.querySelector('button[aria-expanded]');
  if (header?.getAttribute('aria-expanded') === 'false') await press(header);
  await press(root.querySelector('[data-ask-ref="ask:a"] button'));
  // Dismiss shows only once the refetched list no longer holds the item.
  const dismissShown = (): boolean =>
    [...root.querySelectorAll('button')].some(button => button.textContent === 'Dismiss');
  for (let tick = 0; tick < 20 && !dismissShown(); tick++)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  expect(server.gets()).toBeGreaterThan(0);
  expect(dismissShown()).toBe(true);
}

test('answering the only ask in a row keeps the row, open under its #N, until it is dismissed', async () => {
  const server = stubAnswerServer();
  try {
    const root = await mount('/console/p/web/needs-you');
    const header = root.querySelector('[data-item-key="issue-198"] button[aria-expanded]');
    await press(header);
    await answerAskA(root, server);

    expect(rowsIn(root)).toEqual(['issue-198', 'issue-200']);
    // The same header, still mounted and still open: the row was not rebuilt.
    expect(header?.isConnected).toBe(true);
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(header?.textContent).toContain('#198');
    const row = root.querySelector('[data-item-key="issue-198"]');
    expect(row?.querySelector('[data-needs-child] [data-ask-ref="ask:a"]')?.textContent).toContain(
      'Answered: Land it'
    );
    expect(row?.querySelector('[data-suggested]')).toBeNull();
    const sections = [...root.querySelectorAll('[data-item-asks]')];
    expect(sections.every(section => section.closest('[data-needs-row]') !== null)).toBe(true);
    expect(root.querySelector('[role="status"]')?.textContent).toBe('1 open ask');

    const dismiss = [...(row?.querySelectorAll('button') ?? [])].find(
      button => button.textContent === 'Dismiss'
    );
    await press(dismiss);
    expect(rowsIn(root)).toEqual(['issue-200']);
  } finally {
    server.restore();
  }
});

test('the item filter applies to a row whose asks were all answered', async () => {
  const server = stubAnswerServer();
  try {
    const root = await mount('/console/p/web/needs-you?item=198,200');
    await answerAskA(root, server);
    expect(rowsIn(root)).toEqual(['issue-198', 'issue-200']);
    await press(root.querySelector('[data-item-filter="198"] a'));
    expect(rowsIn(root)).toEqual(['issue-200']);
  } finally {
    server.restore();
  }
});

test('after a reload the attention list alone decides the rows', async () => {
  const server = stubAnswerServer();
  try {
    const root = await mount('/console/p/web/needs-you');
    await answerAskA(root, server);
    expect(rowsIn(root)).toEqual(['issue-198', 'issue-200']);
    await unmount?.();
    unmount = undefined;
    const reloaded = await mount('/console/p/web/needs-you', [ask('ask:c', 'issue-200')]);
    expect(rowsIn(reloaded)).toEqual(['issue-200']);
  } finally {
    server.restore();
  }
});
