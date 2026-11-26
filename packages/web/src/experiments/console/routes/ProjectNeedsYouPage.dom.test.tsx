/**
 * The Needs you tab mounted and pressed: a row opens and closes its ask section as its child, and
 * the filter bar's controls take the filter away. The static renders in
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

async function mount(path: string): Promise<HTMLElement> {
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks: [ask('ask:a', 'issue-198'), ask('ask:c', 'issue-200')],
    answerRefusals: {},
    itemIds: new Set<string>(),
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
