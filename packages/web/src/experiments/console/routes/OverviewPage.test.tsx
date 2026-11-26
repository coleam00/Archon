import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Project } from '../primitives/project';
import type { ItemAsk } from '../primitives/run';
import type { ItemRead, PackGraph } from '../skills/items';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { NeedsYouLine, OverviewPage, PackOverview } from './OverviewPage';

afterEach(() => {
  for (const prefix of ['pack-graph', 'pack-view', 'projects', 'runs', 'board']) invalidate(prefix);
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

function seedPack(): void {
  set(K.packGraph('p1', 'flow'), {
    stages: [],
    groups: [],
    arrows: [],
    document: null,
    metricViews: null,
  } as unknown as PackGraph);
  set(K.packView('p1', 'flow'), { path: null, view: null, problems: [] });
}

const ask = (ref: string, message: string, project = 'p1'): ItemAsk => ({
  kind: 'attention',
  ref,
  project: { key: `acme/${project}`, codebaseId: project, name: project },
  item: { id: `item-${ref}`, projectKey: 'acme/p', key: `issue-${ref}` },
  revision: 1,
  labels: {},
  pausedAt: null,
  message,
  form: 'select',
  options: [{ id: 'go', does: 'Goes on.', cost: 'Nothing.' }],
  recommendation: { option: 'go', why: 'It is ready.' },
});

test('the Needs you line comes under the tiles and before the map', () => {
  seedPack();
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PackOverview projectId="p1" pack="flow" items={[merged]} itemsError={undefined} needYou={12}>
        <NeedsYouLine projectId="p1" count={12} />
      </PackOverview>
    </MemoryRouter>
  );
  const tiles = html.indexOf('data-numbers');
  const line = html.indexOf('data-needs-you');
  const map = html.indexOf('data-pack-map');
  expect(tiles).toBeGreaterThan(-1);
  expect(line).toBeGreaterThan(tiles);
  expect(map).toBeGreaterThan(line);
});

test('the Needs you line is the open-ask count, linking to the Needs you tab, and absent at zero or while read', () => {
  const line = (count: number | undefined): string =>
    renderToStaticMarkup(
      <MemoryRouter>
        <NeedsYouLine projectId="p1" count={count} />
      </MemoryRouter>
    );
  expect(line(12)).toContain('href="/console/p/p1/needs-you"');
  expect(line(12)).toContain('>12 need you</a>');
  expect(line(1)).toContain('>1 needs you</a>');
  expect(line(0)).toBe('');
  expect(line(undefined)).toBe('');
});

test('the Overview shows its asks as the one count link, never as ask rows', () => {
  seedPack();
  set(K.projects, [{ id: 'p1', name: 'p', itemPacks: ['flow'] } as unknown as Project]);
  set(K.boardOrders('p1'), [merged]);
  set(K.runsAttention, {
    runs: [],
    ownerLost: [],
    asks: [
      ask('ask:a1', 'Ship the widget?'),
      ask('ask:a2', 'Rename the column?'),
      // Another project's ask: the line counts this project's asks only.
      ask('ask:b1', 'Elsewhere?', 'p2'),
    ],
    answerRefusals: {},
    itemIds: new Set<string>(),
    degraded: [],
  });
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/console/p/p1/overview']}>
      <Routes>
        <Route path="/console/p/:projectId/overview" element={<OverviewPage />} />
      </Routes>
    </MemoryRouter>
  );
  // The tab bar links to the Needs you tab too, so the line is read on its own.
  const start = html.indexOf('<p data-needs-you');
  expect(start).toBeGreaterThan(-1);
  const line = html.slice(start, html.indexOf('</p>', start));
  expect(line).toContain('href="/console/p/p1/needs-you"');
  expect(line).toContain('>2 need you</a>');
  expect(html).not.toContain('Ship the widget?');
  expect(html).not.toContain('Rename the column?');
  expect(html).not.toContain('data-ask-ref');
  expect(html).not.toContain('data-recommended');
});
