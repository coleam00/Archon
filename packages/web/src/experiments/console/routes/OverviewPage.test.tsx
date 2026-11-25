import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { ItemRead, PackGraph } from '../skills/items';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { PackOverview } from './OverviewPage';

afterEach(() => {
  for (const prefix of ['pack-graph', 'pack-view']) invalidate(prefix);
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

test('the open asks come under the tiles and before the map', () => {
  set(K.packGraph('p1', 'flow'), {
    stages: [],
    groups: [],
    arrows: [],
    document: null,
    metricViews: null,
  } as unknown as PackGraph);
  set(K.packView('p1', 'flow'), { path: null, view: null, problems: [] });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PackOverview projectId="p1" pack="flow" items={[merged]} itemsError={undefined} needYou={1}>
        <section data-needs-you />
      </PackOverview>
    </MemoryRouter>
  );
  const tiles = html.indexOf('data-numbers');
  const asks = html.indexOf('data-needs-you');
  const map = html.indexOf('data-pack-map');
  expect(tiles).toBeGreaterThan(-1);
  expect(asks).toBeGreaterThan(tiles);
  expect(map).toBeGreaterThan(asks);
});
