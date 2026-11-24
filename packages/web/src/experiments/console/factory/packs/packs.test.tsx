import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router';
import type { FactoryPacksRead } from '../../skills/factory';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import { FactoryRailLink } from '../FactoryRailLink';
import { OVERVIEW } from '../lib/overview.test-fixtures';
import type { FactoryPackListed } from '../lib/views';
import { factoryPackRoutes } from './routes';

// The index's redirect and the drill-down need a live tree; static markup follows neither.
const dom = new Window({ url: 'http://localhost' });
const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

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
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <LocationProbe />
        <Routes>
          {factoryPackRoutes('/console/')}
          <Route path="/rail" element={<FactoryRailLink />} />
        </Routes>
      </MemoryRouter>
    )
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
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
  test('with one pack, opens its page in place of the index', async () => {
    const page = await mount('/console/factory', listing([pack('acme.kit', 'Kit')]));
    expect(at(page)).toBe('/console/factory/acme.kit/how-it-works');
    expect(page.querySelector('output')?.getAttribute('data-by')).toBe('REPLACE');
  });

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

  test('with one pack and a project it could not read, stays to say so', async () => {
    const page = await mount('/console/factory', {
      ...listing([pack('acme.kit', 'Kit')]),
      unreadProjects: [{ codebaseId: 'cb-9', name: 'gone', error: 'ENOENT' }],
    });
    expect(at(page)).toBe('/console/factory');
    expect(page.querySelector('[role="alert"]')?.textContent).toContain('gone: ENOENT');
    expect(page.querySelectorAll('article')).toHaveLength(1);
  });

  test('a pack whose files are all broken still gets a card, saying so', async () => {
    const page = await mount(
      '/console/factory',
      listing([pack('acme.kit', 'Kit'), pack('acme.web', 'Web', { overview: null })])
    );
    const cards = [...page.querySelectorAll('article')];
    expect(cards).toHaveLength(2);
    // With no overview, the card is still titled by the pack's name and opens its page.
    expect(cards[1]?.querySelector('h2')?.textContent).toBe('Web');
    expect(hrefs(cards[1])).toContain('/console/factory/acme.web/how-it-works');
  });
});

describe('/console/factory/:pack/how-it-works', () => {
  const two = listing([
    pack('acme.kit', 'How the kit works'),
    pack('acme.web', 'Web', { readFrom: null }),
  ]);

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

  test('the file it was read from is a detail behind Source, not a line of the header', async () => {
    const page = await mount('/console/factory/acme.kit/how-it-works', two);
    const header = page.querySelector('header');
    // Closed: the header names neither a project nor the file.
    expect(header?.textContent).not.toContain('factory-overview.json');
    expect(header?.textContent).not.toContain('web');
    const toggle = header?.querySelector('button[aria-expanded]');
    expect(toggle?.textContent).toBe('Source');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      (toggle as HTMLElement).click();
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const source = document.getElementById(toggle?.getAttribute('aria-controls') ?? '');
    expect(source?.textContent).toContain("a project's copy of the overview file");
    expect(source?.textContent).toContain('acme.kit.factory-overview.json');
    // A pack's page names no project, even where its file came from one.
    expect(source?.textContent).not.toContain('web');
    expect(hrefs(source)).toEqual([]);
  });

  test("the pack's own file names no project", async () => {
    const page = await mount('/console/factory/acme.web/how-it-works', two);
    // The source sits behind the Source toggle: open it, then read what it says.
    const toggle = page.querySelector<HTMLElement>('header button[aria-expanded]');
    await act(async () => {
      toggle?.click();
    });
    const source = document.getElementById(toggle?.getAttribute('aria-controls') ?? '');
    expect(source?.textContent).toContain("the pack's own overview file");
    expect(hrefs(source).filter(href => href.startsWith('/console/p/'))).toEqual([]);
  });

  test('is the only page: no tabs, no Settings, no project named or linked', async () => {
    const page = await mount('/console/factory/acme.kit/how-it-works', two);
    expect(page.querySelector('nav[aria-label="Pack"]')).toBeNull();
    expect(hrefs(page).filter(href => href.endsWith('/settings'))).toEqual([]);
    expect(hrefs(page).filter(href => href.startsWith('/console/p/'))).toEqual([]);
    expect(page.textContent).not.toContain('Settings');
  });

  test("the old Settings address lands on that project's Settings, else on How it works", async () => {
    const withProject = await mount('/console/factory/acme.kit/settings?project=cb-1#land', two);
    expect(at(withProject)).toBe('/console/p/cb-1/factory/settings');
    expect(withProject.querySelector('output')?.getAttribute('data-by')).toBe('REPLACE');
    await unmount?.();
    unmount = undefined;
    const without = await mount('/console/factory/acme.kit/settings', two);
    expect(at(without)).toBe('/console/factory/acme.kit/how-it-works');
  });

  test('the bare pack address opens How it works', async () => {
    const page = await mount('/console/factory/acme.kit', two);
    expect(at(page)).toBe('/console/factory/acme.kit/how-it-works');
  });

  test('an unknown pack says so and links every pack', async () => {
    const page = await mount('/console/factory/nope/how-it-works', two);
    expect(page.querySelector('[data-card]')).toBeNull();
    expect(page.textContent).toContain('No installed pack keyed "nope"');
    const back = page.querySelector('a[data-back-link]');
    expect(back?.getAttribute('href')).toBe('/console/factory');
    expect(back?.className).not.toContain('underline');
  });

  test("a broken pack file's error shows on its page", async () => {
    const page = await mount(
      '/console/factory/acme.kit/how-it-works',
      listing([
        pack('acme.kit', 'Kit', {
          overview: null,
          readFrom: null,
          errors: [{ pack: 'acme/kit', source: 'installed', path: '/p/o.json', error: 'bad root' }],
        }),
      ])
    );
    expect(page.querySelector('[role="alert"]')?.textContent).toContain('bad root');
  });
});
