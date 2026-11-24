import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router';
import type { FactoryPacksRead } from '../../skills/factory';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import { installDom } from '../../test-dom.test-helpers';
import { FactoryRailLink } from '../FactoryRailLink';
import { OVERVIEW } from '../lib/overview.test-fixtures';
import type { FactoryPackListed } from '../lib/views';
import { factoryPackRoutes } from './routes';

// The index's redirect and the drill-down need a live tree; static markup follows neither.
const { mount: mountTree } = await installDom();

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  invalidate(K.factoryPacks);
});

const pack = (key: string, title: string, more: Partial<FactoryPackListed> = {}) => ({
  pack: key.replace('.', '/'),
  key,
  overview: {
    pack: key.replace('.', '/'),
    source: 'project-file' as const,
    path: `/repo/.archon/packs/${key}.factory-overview.json`,
    declaration: { ...OVERVIEW, title },
  },
  readFrom: { codebaseId: 'cb-1', name: 'web' },
  projects: [{ codebaseId: 'cb-1', name: 'web' }],
  errors: [],
  ...more,
});
const listing = (packs: FactoryPackListed[]): FactoryPacksRead => ({
  packs,
  errors: [],
  unreadProjects: [],
});

function LocationProbe(): ReactElement {
  const { pathname, search } = useLocation();
  return <output data-at={pathname + search} data-by={useNavigationType()} />;
}

async function mount(at: string, packs: FactoryPacksRead): Promise<HTMLElement> {
  set(K.factoryPacks, packs);
  const page = await mountTree(
    <MemoryRouter initialEntries={[at]}>
      <LocationProbe />
      <Routes>
        {factoryPackRoutes('/console/')}
        <Route path="/rail" element={<FactoryRailLink />} />
      </Routes>
    </MemoryRouter>
  );
  unmount = page.unmount;
  return page.container;
}

const at = (page: HTMLElement): string | null =>
  page.querySelector('output')?.getAttribute('data-at') ?? null;
const hrefs = (within: ParentNode | null | undefined): string[] =>
  [...(within?.querySelectorAll('a') ?? [])].map(a => a.getAttribute('href') ?? '');

describe('the sidebar Factory entry', () => {
  test('shows once a pack is listed, and is absent with none', async () => {
    const shown = await mount('/rail', listing([pack('acme.kit', 'Kit')]));
    expect(hrefs(shown)).toEqual(['/console/factory']);
    await unmount?.();

    const hidden = await mount('/rail', listing([]));
    expect(hrefs(hidden)).toEqual([]);
  });
});

describe('/console/factory', () => {
  test('with two, a card each: title, summary and how many projects run it, naming none', async () => {
    const page = await mount(
      '/console/factory',
      listing([
        pack('acme.kit', 'Kit'),
        pack('acme.web', 'Web', {
          projects: [
            { codebaseId: 'cb-1', name: 'web' },
            { codebaseId: 'cb-2', name: 'api' },
          ],
        }),
      ])
    );
    const cards = [...page.querySelectorAll('article')];
    // Each card is titled by the pack's name as a person reads it (its id on hover), its
    // overview's caption under it.
    expect(cards.map(card => card.querySelector('h2')?.textContent)).toEqual(['Kit', 'Web']);
    expect(cards[0]?.querySelector('h2 a')?.getAttribute('title')).toBe('acme/kit');
    expect(cards[0]?.textContent).toContain(OVERVIEW.caption);
    expect(cards[0]?.textContent).toContain('Runs on 1 project');
    expect(cards[1]?.textContent).toContain('Runs on 2 projects');
    // The index names no project: it counts them, and links only to the pack's own page.
    expect(hrefs(cards[1])).toEqual(['/console/factory/acme.web/how-it-works']);
    expect(cards[1]?.textContent).not.toContain('web');
    expect(cards[1]?.textContent).not.toContain('api');
  });
});

const two = listing([
  pack('acme.kit', 'How the kit works'),
  pack('acme.web', 'Web', { readFrom: null }),
]);

test.each([
  [
    '/console/factory',
    listing([pack('acme.kit', 'Kit')]),
    '/console/factory/acme.kit/how-it-works',
  ],
  ['/console/factory/acme.kit', two, '/console/factory/acme.kit/how-it-works'],
  ['/console/factory/acme.kit/settings?project=cb-1#land', two, '/console/p/cb-1/factory/settings'],
  ['/console/factory/acme.kit/settings', two, '/console/factory/acme.kit/how-it-works'],
] as const)('%s opens %p', async (from, packs, to) => {
  const page = await mount(from, packs);
  expect(at(page)).toBe(to);
  expect(page.querySelector('output')?.getAttribute('data-by')).toBe('REPLACE');
});

describe('/console/factory/:pack/how-it-works', () => {
  test.each([
    ['acme.kit', ["a project's copy of the overview file", 'acme.kit.factory-overview.json']],
    ['acme.web', ["the pack's own overview file"]],
  ])('%s: the file it was read from is behind Source, naming no project', async (key, says) => {
    const page = await mount(`/console/factory/${key}/how-it-works`, two);
    const header = page.querySelector('header');
    expect(header?.textContent).not.toContain('factory-overview.json');
    expect(header?.textContent).not.toContain('web');
    const toggle = header?.querySelector<HTMLElement>('button[aria-expanded]');
    expect(toggle?.textContent).toBe('Source');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      toggle?.click();
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const source = document.getElementById(toggle?.getAttribute('aria-controls') ?? '');
    for (const words of says) expect(source?.textContent).toContain(words);
    expect(source?.textContent?.replaceAll(key, '')).not.toContain('web');
    expect(hrefs(source)).toEqual([]);
  });

  test("draws the overview with ?view= open, under the pack's readable name", async () => {
    const page = await mount('/console/factory/acme.kit/how-it-works?view=make', two);
    const crumbs = [...page.querySelectorAll('nav[aria-label="Breadcrumb"] li')].map(li =>
      li.textContent?.replace('›', '').trim()
    );
    // The overview's title heads the map (its breadcrumb's root); the page names the pack,
    // its raw id only on hover.
    expect(crumbs).toEqual(['How the kit works', 'Make']);
    const h1 = page.querySelector('h1');
    expect(h1?.textContent).toBe('Kit');
    expect(h1?.getAttribute('title')).toBe('acme/kit');
  });

  test('is the only page: no tabs, no Settings, no project named or linked', async () => {
    const page = await mount('/console/factory/acme.kit/how-it-works', two);
    expect(page.querySelector('nav[aria-label="Pack"]')).toBeNull();
    expect(hrefs(page).filter(href => href.endsWith('/settings'))).toEqual([]);
    expect(hrefs(page).filter(href => href.startsWith('/console/p/'))).toEqual([]);
    expect(page.textContent).not.toContain('Settings');
  });
});
