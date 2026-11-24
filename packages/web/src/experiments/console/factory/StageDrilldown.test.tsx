import { afterAll, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryViews, FactoryWorkflow } from '../skills/factory';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { projectRoutes } from '../routes/project-routes';
import { installDom } from '../test-dom.test-helpers';
import { checksDrilldown } from './lib/fixtures/checks-drilldown';
import deliverJson from './lib/fixtures/deliver-workflow.json';
import {
  capturedItemAs,
  capturedItemsPage,
  isItemsRead,
  itemsReadAnswer,
} from './lib/fixtures/factory-items-page';

// Opening a stage, a step and the tabs are clicks, and static markup cannot click.
const { mount, settle } = await installDom();
afterAll(() => {
  for (const key of ['factory-views', 'factory-workflow', 'factory-items', 'runs']) invalidate(key);
});

const ID = 'cb-1';
const deliver = deliverJson as FactoryWorkflow;
const views: FactoryViews = {
  views: [
    {
      pack: 'acme/kit',
      packKey: 'acme.kit',
      runNames: { deliver: 'acme/kit:deliver' },
      source: 'project-file',
      path: '/repo/.archon/packs/acme.kit.factory-view.json',
      declaration: {
        version: 1,
        pack: 'acme/kit',
        title: 'Kit factory',
        summary: 'Issues come in; changes go out.',
        stages: [
          // No drill-down: its modal opens on the real step graph.
          { id: 'build', label: 'Build', blurb: 'Builds.', group: 'build', workflows: ['deliver'] },
          {
            id: 'checks',
            label: 'Checks',
            blurb: 'Checks the change.',
            group: 'check',
            workflows: ['deliver'],
            nodes: ['rounds.review__review'],
            drilldown: checksDrilldown,
          },
        ],
        placement: {},
        endings: {},
        landed: { stage: 'checks' },
        steps: { deliver: { 'rounds.review__review': 'Reviews the change' } },
        map: { cards: [], arrows: [] },
      },
    },
  ],
  errors: [],
};

function serve(items: (url: string) => Response): void {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/factory/views')) return Response.json(views);
      if (url.includes('/api/factory/workflow')) return Response.json(deliverJson);
      if (isItemsRead(url)) return items(url);
      if (url.includes('/api/runs/attention'))
        return Response.json({ items: [], runs: [], degraded: [] });
      return Response.json({ error: 'not in this test' }, { status: 404 });
    },
    { preconnect: fetch.preconnect }
  );
  set(K.factoryViews(ID), views);
  set(K.factoryWorkflow(ID, 'deliver'), deliver);
  // Each test starts from a cold items read, so it loads what this test serves.
  invalidate('factory-items');
}

async function renderAt(path: string, check: (body: HTMLElement) => Promise<void>): Promise<void> {
  const mounted = await mount(
    <MemoryRouter initialEntries={[path]}>
      <Routes>{projectRoutes('/console/')}</Routes>
    </MemoryRouter>
  );
  try {
    await settle();
    // The stage modal portals to the body, outside the root.
    await check(document.body as unknown as HTMLElement);
  } finally {
    await mounted.unmount();
  }
}

const click = async (target: Element | null | undefined): Promise<void> => {
  await act(async () => {
    (target as HTMLElement | null)?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};
function stepButton(body: HTMLElement, label: string): HTMLButtonElement {
  const button = [...body.querySelectorAll('button')].find(b => b.textContent.startsWith(label));
  if (!button) throw new Error(`The stage graph drew no ${label} step`);
  return button;
}
/** The item links on the page, or in the stage modal when it is open. */
const itemLinks = (body: HTMLElement): string[] =>
  [
    ...(body.querySelector('[role="dialog"]') ?? body).querySelectorAll(
      'a[href*="/factory/items/"]'
    ),
  ].map(link => link.getAttribute('href') ?? '');
const phaseLabels = (root: Element): string[] =>
  [...root.querySelectorAll('[data-phase]')].map(phase => phase.getAttribute('aria-label') ?? '');
const liveCards = (body: HTMLElement): string[] =>
  [...body.querySelectorAll('article[data-live]')].map(
    c => c.querySelector('a')?.textContent ?? ''
  );
const cardLink = (body: HTMLElement, text: string): HTMLAnchorElement => {
  const found = [...body.querySelectorAll<HTMLAnchorElement>('article > a')].find(a =>
    a.textContent.includes(text)
  );
  if (!found) throw new Error(`No card reads ${text}`);
  return found;
};
const on = (key: string, step: string) =>
  capturedItemAs(key, {
    running: { runId: `run-${key}`, workflow: 'deliver', step, startedAt: '2026-11-17T07:00:00Z' },
  });

// Newest activity first: #4's run started after #12's.
const capturedLinks = ['4', '12', '6'].map(key => `/console/p/${ID}/factory/items/${key}`);

test('a stage with no drill-down opens on its graph, glows the running step, and a step opens its page and leads back', async () => {
  serve(itemsReadAnswer(capturedItemsPage.items));
  await renderAt(`/console/p/${ID}/factory?stage=build`, async body => {
    const selected = body.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe('The real workflow');
    expect(body.textContent).toContain('Running now');
    expect(itemLinks(body)).toEqual(capturedLinks);
    const build = stepButton(body, '·build');
    expect(build.hasAttribute('data-running')).toBe(true);
    expect(build.title).toContain('Running for #4, #12, #6');
    expect(stepButton(body, '·fix').hasAttribute('data-running')).toBe(false);

    await click(stepButton(body, '·fix'));
    expect(body.querySelector('[data-id-tag]')?.textContent).toBe('rounds.fix');
    const back = body.querySelector<HTMLAnchorElement>('a[data-back-link]');
    expect(back?.textContent).toBe('Back to Build');
    await click(back);
    expect(document.querySelector('[role="dialog"] h3')?.textContent).toBe('Build');
  });
});

test('the step page draws the items on the step as board cards, and says when there are none', async () => {
  serve(itemsReadAnswer(capturedItemsPage.items));
  await renderAt(`/console/p/${ID}/factory/steps/deliver/build__build`, async body => {
    expect(body.textContent).toContain('Items on this step now');
    expect([...body.querySelectorAll('[data-card]')].map(c => c.getAttribute('data-card'))).toEqual(
      ['4', '12', '6']
    );
    // Each card's own link to its item, in the read's order (a card may link its item twice).
    expect([...new Set(itemLinks(body))]).toEqual(capturedLinks);
  });
  await renderAt(`/console/p/${ID}/factory/steps/deliver/rounds.fix`, async body => {
    expect(itemLinks(body)).toEqual([]);
    expect(body.textContent).toContain('No item is on this step now.');
  });
});

test('the drill-down tells numbered phases of cards in one loop; a card glows, links its items and opens its step page', async () => {
  serve(itemsReadAnswer([on('7', 'rounds.review__review')]));
  await renderAt(`/console/p/${ID}/factory?stage=checks`, async body => {
    expect(phaseLabels(body)).toEqual([
      'Phase 1: Prepare',
      'Phase 2: Check',
      'Phase 3: Verdict',
      'Phase 4: Out of rounds',
    ]);
    expect(body.querySelectorAll('article')).toHaveLength(7);
    const loops = [...body.querySelectorAll('[data-loop]')];
    expect(loops).toHaveLength(1);
    expect(loops[0]?.textContent).toContain('Up to 3 rounds');
    expect(phaseLabels(loops[0]!)).toEqual([
      'Phase 1: Prepare',
      'Phase 2: Check',
      'Phase 3: Verdict',
    ]);
    expect(liveCards(body)).toEqual([expect.stringContaining('Code review')]);
    const lit = body.querySelector('article[data-live]');
    expect(lit?.hasAttribute('data-running')).toBe(true);
    // The items are links of their own beside the card's link, never inside it.
    expect(
      [...(lit?.querySelectorAll(':scope > div a') ?? [])].map(a => a.getAttribute('href'))
    ).toEqual([`/console/p/${ID}/factory/items/7`]);
    expect(lit?.querySelector('a a')).toBeNull();

    const review = cardLink(body, 'Code review');
    expect(review.textContent).toContain("Reads the change for bugs and the project's rules");
    expect(review.getAttribute('href')).toBe(
      `/console/p/${ID}/factory/steps/deliver/rounds.review__review`
    );
    expect(body.textContent).not.toContain('The real steps');
    await click(review);
    expect(body.querySelector('[data-id-tag]')?.textContent).toBe('rounds.review__review');
    expect(body.textContent).toContain('Back to Checks');
  });
});

test('the stage modal tabs switch between the phases, the items and the real step graph', async () => {
  serve(itemsReadAnswer([]));
  await renderAt(`/console/p/${ID}/factory?stage=checks`, async body => {
    const graphStep = () =>
      [...body.querySelectorAll('button')].find(b => b.textContent.startsWith('·fix'));
    const tab = (name: string) =>
      [...body.querySelectorAll('[role="tab"]')].find(candidate => candidate.textContent === name);
    expect(phaseLabels(body)).toHaveLength(4);
    expect(graphStep()).toBeUndefined();
    await click(tab('The real workflow'));
    expect(graphStep()).toBeDefined();
    expect(phaseLabels(body)).toHaveLength(0);
    await click(tab('Items here now'));
    expect(body.textContent).toContain('Nothing is in this stage now.');
    await click(tab('What this stage does'));
    expect(phaseLabels(body)).toHaveLength(4);
  });
});
