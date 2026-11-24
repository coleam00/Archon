import { afterEach, expect, jest, test } from 'bun:test';
import { act, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes } from 'react-router';
import { documentPageProblems } from '../../factory/document.test-helpers';
import { shippedListed } from '../../factory/item-detail.test-fixtures';
import { needsShaping } from '../../factory/lib/board.test-fixtures';
import { run, settledItem, type TestRun } from '../../factory/lib/map.test-fixtures';
import {
  askItem,
  gateItem,
  overdueWaitItem,
  usageLimitItem,
} from '../../lib/needs-you.test-fixtures';
import { projectRoutes } from '../../routes/project-routes';
import type { FactoryItem, FactoryViews } from '../../skills/factory';
import type { ItemRead } from '../../skills/items';
import type { AttentionQueue } from '../../skills/runs';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import { installDom } from '../../test-dom.test-helpers';
import { ANSWERED_SHOWN_MS } from '../ask-card/useAnsweredHold';
import { NeedsYouContent } from './NeedsYouLayout';

const ID = 'cb-needs-design';
const { mount, settle } = await installDom();
const unserved = globalThis.fetch;

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = unserved;
  for (const prefix of ['factory-views', 'factory-items', 'runs', 'project']) invalidate(prefix);
});

const none: FactoryViews = { views: [], errors: [] };
const withView: FactoryViews = { views: [shippedListed], errors: [] };
const seven = { id: 'item-7', projectKey: 'acme', key: '#7' };
const nine = { id: 'item-9', projectKey: 'acme', key: '#9' };
const queueOf = (...items: AttentionQueue['items']): AttentionQueue => ({
  items,
  runs: [],
  degraded: [],
});
const quiet = queueOf();

/** The tab as the route draws it, parsed into a DOM to query. */
function render(listing: FactoryViews, queue: AttentionQueue, items: FactoryItem[] = []): Element {
  set(K.factoryViews(ID), listing);
  set(K.projectAttention(ID), queue);
  set(K.factoryItems(ID), { items, members: {} });
  set(
    K.projectItems(ID),
    items.map(({ progress: _progress, ...read }): ItemRead => read)
  );
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/console/p/${ID}/needs-you`]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
  return root;
}
const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** A chip's figure and label, as a person reads them. */
const chipWords = (root: Element, label: string): string => {
  const el = [...root.querySelectorAll('[data-stat-chip]')].find(c => text(c).endsWith(label));
  return [...(el?.childNodes ?? [])]
    .map(node => text(node as Element))
    .join(' ')
    .trim();
};
const panelLabels = (root: Element): (string | null)[] =>
  [...root.querySelectorAll('section[data-needs-you="open"] article[data-doc-panel]')].map(panel =>
    panel.getAttribute('aria-label')
  );
/** Item `key` whose set of asks settled at `at` and started `restarted`, when given. */
const answeredOn = (key: string, at: string, restarted?: TestRun): FactoryItem =>
  settledItem(key, run('plan', 'completed', 'ask'), at, restarted);

test('a busy page counts what waits, groups asks by item, names gate runs, and holds the page rule', () => {
  const now = Date.now();
  const ago = (ms: number): string => new Date(now - ms).toISOString();
  const queue: AttentionQueue = {
    ...queueOf(
      askItem({ ref: 'ask:7a', item: seven, pausedAt: ago(20 * 60_000) }),
      askItem({
        ref: 'ask:9',
        item: nine,
        recommendation: undefined,
        pausedAt: ago(2 * 3_600_000),
      }),
      askItem({ ref: 'ask:7b', item: seven, message: 'Rebase?', pausedAt: ago(60 * 60_000) }),
      gateItem({ ref: 'gate:1' }),
      // A usage limit retries by itself: it needs no one.
      usageLimitItem()
    ),
    degraded: [{ type: 'degraded', reason: 'run_unreadable', runId: 'r-x' }],
  } as AttentionQueue;
  const root = render(none, queue, [answeredOn('a', ago(0)), answeredOn('b', ago(7 * 86_400_000))]);
  expect(root.querySelector('[aria-label="4 waiting"]')).not.toBeNull();
  expect(chipWords(root, 'waiting now')).toBe('4 waiting now');
  // `a`'s two answers today; its withdrawn one and `b`'s last week do not count.
  expect(chipWords(root, 'answered today')).toBe('2 answered today');
  expect(chipWords(root, 'oldest wait')).toBe('2 h oldest wait');
  expect(text(root)).toContain('4 things need you');
  expect(text(root)).toContain('on 2 items and 1 run');
  // One panel per item, newest ask first, then the gate's run; without a view, the run links.
  expect(panelLabels(root)).toEqual(['Asks on #7', 'Asks on #9', 'Asks on Run run-gate']);
  const seventh = text(root.querySelector('[aria-label="Asks on #7"]'));
  expect(seventh.indexOf('Which base should the change target?')).toBeLessThan(
    seventh.indexOf('Rebase?')
  );
  expect(root.innerHTML).toContain(`href="/console/p/${ID}/r/run-gate"`);
  expect(text(root)).toContain(
    'One paused run could not be read, so what it waits on is not listed.'
  );
  expect(documentPageProblems(root)).toEqual([]);
});

test('a wait past its deadline has its own section: what it waits for and its run, no ping', () => {
  const root = render(none, queueOf(askItem({ item: seven }), overdueWaitItem()));
  const paused = root.querySelector('section[data-needs-you="paused"]');
  expect(text(paused)).toContain('Waiting past their deadline');
  expect(text(paused)).toContain('CI on the change');
  expect(paused?.innerHTML).toContain(`href="/console/p/${ID}/r/run-wait"`);
  expect(paused?.querySelector('[data-ping]')).toBeNull();
  expect(chipWords(root, 'waiting now')).toBe('2 waiting now');
});

test('a wait on a run no item holds is counted and named as a run, its workflow named once', () => {
  const root = render(none, queueOf(gateItem({ ref: 'gate:1' })));
  expect(text(root)).toContain('1 thing needs you');
  expect(text(root)).toContain('on 1 run');
  expect(
    text(root.querySelector('[aria-label="Asks on Run run-gate"]')).match(/deliver/g)
  ).toHaveLength(1);
});

test('with nothing open: "Nothing needs you", when last asked, the board and the runs', () => {
  const root = render(withView, quiet, [answeredOn('a', '2026-11-17T10:00:00.000Z')]);
  const empty = root.querySelector('section[aria-label="Nothing needs you"]');
  expect(text(empty)).toContain('Last asked');
  expect([...(empty?.querySelectorAll('a') ?? [])].map(a => a.getAttribute('href'))).toEqual([
    `/console/p/${ID}/factory/board`,
    `/console/p/${ID}`,
  ]);
  expect(chipWords(root, 'waiting now')).toBe('0 waiting now');
});

test('answered lately: the newest rows, each with its answer, who gave it and what it started', () => {
  const at = (hour: number): string => `2026-11-17T0${hour.toString()}:00:00.000Z`;
  const root = render(none, quiet, [
    answeredOn('none', at(1)),
    answeredOn('running', at(2), run('plan', 'running', null, 'plan')),
  ]);
  const rows = [...root.querySelectorAll('section[aria-label="Answered lately"] li')];
  expect(rows).toHaveLength(6);
  expect(text(rows[0])).toContain('running');
  expect(text(rows[0]?.querySelector('[data-answer-pill]'))).toBe('Approve');
  expect(text(rows[0])).toContain('by cole-owner');
  expect(text(rows[0]?.querySelector('[data-started] a'))).toBe('Plan started again');
  expect(rows.some(row => text(row).includes('Withdrawn'))).toBe(true);
  expect(text(rows.at(-1)?.querySelector('[data-started]'))).toBe('Nothing started');
});

test('an item waiting on you with no ask open is listed with its questions and counted', () => {
  const root = render(withView, queueOf(askItem({ item: seven })), [
    needsShaping('9s', ['Which surfaces?', 'Who owns it?']),
  ]);
  const panel = root.querySelector('section[data-needs-you="awaiting"] article');
  expect(text(panel)).toContain('Needs shaping');
  expect([...(panel?.querySelectorAll('li') ?? [])].map(text)).toEqual([
    'Which surfaces?',
    'Who owns it?',
  ]);
  expect(panel?.querySelector('a')?.getAttribute('href')).toBe(`/console/p/${ID}/factory/items/9s`);
  expect(chipWords(root, 'waiting now')).toBe('2 waiting now');
});

test.each([
  ['issue-7', '#7', false],
  ['issue-136-item-keys', '#136 · item keys', true],
])(
  '%s reads %s on its open ask and its answered row, whose links keep the key',
  (key, shown, split) => {
    const plain = answeredOn(key, '2026-11-17T10:00:00.000Z');
    const answered: FactoryItem = split
      ? {
          ...plain,
          links: [
            {
              id: 'link-136',
              kind: 'part_of',
              direction: 'outgoing',
              other: { id: 'item-136', projectKey: plain.item.projectKey, key: 'issue-136' },
              at: '2026-11-17T10:00:00.000Z',
              via: 'cli',
              by: null,
              fromRun: null,
              ended: null,
            },
          ],
        }
      : plain;
    const href = `/console/p/${ID}/factory/items/${key}`;
    const open = render(withView, queueOf(askItem({ ref: `ask:${key}`, item: answered.item })), [
      answered,
    ]);
    expect(panelLabels(open)).toEqual([`Asks on ${shown}`]);
    expect(
      text(open.querySelector(`section[data-needs-you="open"] h3 a[href="${href}"]`))
    ).toStartWith(shown);
    const row = render(withView, quiet, [answered]).querySelector(
      `section[aria-label="Answered lately"] li a[href="${href}"]`
    );
    expect(text(row)).toContain(shown);
  }
);

test('answering the last ask keeps it in its panel, saying so, before the empty state', async () => {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) =>
      String(input).includes('/api/attention/answer')
        ? Response.json({ success: true })
        : Response.json({ error: 'not in this test' }, { status: 404 }),
    { preconnect: unserved.preconnect }
  );
  let setQueue: (next: AttentionQueue) => void = () => undefined;
  function Host() {
    const [current, setCurrent] = useState(queueOf(askItem({ ref: 'ask:1', item: seven })));
    setQueue = setCurrent;
    return <NeedsYouContent projectId="cb-live" view={undefined} queue={current} />;
  }
  const { container, unmount } = await mount(
    <MemoryRouter>
      <Host />
    </MemoryRouter>
  );
  const click = async (label: string): Promise<void> => {
    const button = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.startsWith(label)
    );
    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  try {
    for (let turn = 0; turn < 5; turn++) await settle();
    jest.useFakeTimers();
    await click('Use dev');
    await click('Confirm');
    await act(async () => setQueue(quiet));
    const panel = container.querySelector('[aria-label="Asks on #7"]');
    expect(text(panel?.querySelector('[role="status"]'))).toBe('Answered: Use dev');
    expect(container.querySelector('section[aria-label="Nothing needs you"]')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(ANSWERED_SHOWN_MS);
    });
    expect(container.querySelector('[aria-label="Asks on #7"]')).toBeNull();
    expect(container.querySelector('section[aria-label="Nothing needs you"]')).not.toBeNull();
  } finally {
    jest.useRealTimers();
    await unmount();
    invalidate('factory-items');
  }
});
