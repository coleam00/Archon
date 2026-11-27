/**
 * The Overview mounted. With the attention list failing and nothing read before (#258), the
 * need-you tile shows "?" rather than a skeleton that never resolves, and the page says once
 * that the asks could not be read; the static renders in `OverviewPage.test.tsx` cover the tile
 * while the asks are still read. An Overview is never blank (#295), and a pack's summary is its
 * document's first paragraph.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { installDom } from '../factory/test-dom.test-helpers';
import type { Project } from '../primitives/project';
import type { ItemAsk } from '../primitives/run';
import type { ItemRead, PackGraph } from '../skills/items';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';

const { mount, settle } = await installDom();
// Loaded after the window exists: react-dom reads it when it loads.
const { OverviewPage } = await import('./OverviewPage');

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  // Once nothing subscribes, invalidating also clears the failed read's error.
  for (const prefix of ['projects', 'board', 'pack-graph', 'runs']) invalidate(prefix);
});

/** An item merged today, so the pack has something on its board. */
const merged = {
  item: { id: 'i1', projectKey: 'p', key: '1', title: null },
  standing: { runId: 'r1', state: 'done', pack: 'flow' },
  runs: [
    {
      id: 'r1',
      workflow: 'acme/flow:land',
      pack: { key: 'flow', workflow: 'land' },
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
    },
  ],
  questions: [],
  links: [],
  merged: { at: new Date().toISOString() },
} as unknown as ItemRead;

/** Seeds the project, its one pack's board and graph; not the attention list. */
function seedPack(): void {
  set(K.projects, [{ id: 'p1', name: 'p', itemPacks: ['flow'] } as unknown as Project]);
  set(K.boardOrders('p1'), [merged]);
  set(K.packGraph('p1', 'flow'), {
    stages: [],
    groups: [],
    arrows: [],
    document: null,
    metricViews: null,
  } as unknown as PackGraph);
}

async function mountOverview(): Promise<HTMLElement> {
  const mounted = await mount(
    <MemoryRouter initialEntries={['/console/p/p1/overview']}>
      <Routes>
        <Route path="/console/p/:projectId/overview" element={<OverviewPage />} />
      </Routes>
    </MemoryRouter>
  );
  unmount = mounted.unmount;
  await settle();
  return mounted.container;
}

test('an Overview whose asks could not be read says so once, and its need-you tile does not read forever', async () => {
  seedPack();
  // The attention list is not cached, so the page reads it, through the test's fetch, which fails.
  invalidate(K.runsAttention);
  const page = await mountOverview();

  const tile = page.querySelector('[data-number="need-you"]');
  expect(tile).not.toBeNull();
  expect(tile?.querySelector('[title="Reading"]')).toBeNull();
  expect(tile?.querySelector('[data-value-unread]')?.textContent).toBe('?');

  const alerts = page.querySelectorAll('[data-asks-unread]');
  expect(alerts.length).toBe(1);
  const alert = alerts[0]?.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('/api/runs/attention');
  expect(page.querySelector('[data-needs-you]')).toBeNull();

  // What was drawn stays drawn: the other tiles' figures and the map.
  expect(page.querySelector('[data-number="in-flight"] [data-value]')?.textContent).toBe('0');
  expect(page.querySelector('[data-number="merged-today"] [data-value]')?.textContent).toBe('1');
  expect(page.querySelector('[data-pack-map]')).not.toBeNull();
});

test('a failed re-read of the asks keeps the asks read before on the Overview, with no alert (#258)', async () => {
  seedPack();
  const ask: ItemAsk = {
    kind: 'attention',
    ref: 'ask:a1',
    project: { key: 'acme/p1', codebaseId: 'p1', name: 'p1' },
    item: { id: 'item-a1', projectKey: 'acme/p', key: 'issue-a1' },
    priority: false,
    revision: 1,
    labels: {},
    pausedAt: null,
    message: 'Ship it?',
    form: 'select',
    options: [{ id: 'go', does: 'Goes on.', cost: 'Nothing.' }],
    recommendation: { option: 'go', why: 'It is ready.' },
  };
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks: [ask],
    answerRefusals: {},
    itemIds: new Set(['item-a1']),
    refs: new Set<string>(),
    degraded: [],
  });
  const page = await mountOverview();
  // The attention list is read again, through the test's fetch, which fails.
  await act(async () => {
    invalidate(K.runsAttention);
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  expect(page.querySelector('[data-asks-unread]')).toBeNull();
  expect(page.querySelector('[data-number="need-you"] [data-value]')?.textContent).toBe('1');
  expect(page.querySelector('[data-needs-you]')).not.toBeNull();
});

/** Seeds an empty attention list, so the page asks nothing of the network. */
function noAsks(): void {
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks: [],
    answerRefusals: {},
    itemIds: new Set<string>(),
    refs: new Set<string>(),
    degraded: [],
  });
}

test('a project where no work has started says so rather than drawing nothing', async () => {
  set(K.projects, [{ id: 'p1', name: 'p', itemPacks: [] } as unknown as Project]);
  set(K.boardOrders('p1'), []);
  noAsks();
  const page = await mountOverview();
  expect(page.querySelector('[data-empty-overview]')?.textContent).toContain('No work has started');
  expect(page.querySelector('[data-pack]')).toBeNull();
});

test('a pack with nothing on its board still shows its tiles and map, and says nothing is on a stage', async () => {
  seedPack();
  set(K.boardOrders('p1'), []);
  noAsks();
  const page = await mountOverview();
  expect(page.querySelector('[data-pack="flow"]')).not.toBeNull();
  expect(page.querySelector('[data-number="in-flight"] [data-value]')?.textContent).toBe('0');
  expect(page.querySelector('[data-empty-board]')).not.toBeNull();
  expect(page.querySelector('[data-pack-map]')).not.toBeNull();
  expect(page.querySelector('[data-empty-overview]')).toBeNull();
});

test("the pack's summary is its document's first paragraph, linking to How it works", async () => {
  seedPack();
  set(K.packGraph('p1', 'flow'), {
    stages: [],
    groups: [],
    arrows: [],
    document: {
      path: 'how-it-works.md',
      problems: [],
      text: '# How the flow works\n\nWork comes in **once**.\n\n## Later\n\nNot the summary.',
    },
    metricViews: null,
  } as unknown as PackGraph);
  noAsks();
  const page = await mountOverview();
  const summary = page.querySelector('[data-summary]');
  expect(summary?.textContent).toBe('Work comes in once.');
  expect(summary?.querySelector('strong')?.textContent).toBe('once');
  expect(page.textContent).not.toContain('Not the summary');
  expect(page.textContent).not.toContain('How the flow works');
  const link = [...page.querySelectorAll('a')].find(a => a.textContent === 'How it works');
  expect(link?.getAttribute('href')).toBe('/console/factory/flow/how-it-works');
  expect(page.querySelector('[data-empty-board]')).toBeNull();
});
