import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { FactoryViews, FactoryWorkflow } from '../skills/factory';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { ProjectAttentionLayout } from '../components/ProjectAttention';
import { FactoryPage } from './FactoryPage';
import { StepPage } from './StepPage';
import { checksDrilldown } from './lib/fixtures/checks-drilldown';
import deliverJson from './lib/fixtures/deliver-workflow.json';
import { capturedItemAs, isItemsRead, itemsReadAnswer } from './lib/fixtures/factory-items-page';

// Opening a card and the tabs are clicks, and static markup cannot click.
const dom = new Window({ url: 'http://localhost' });
// The frame keeps the Needs-you count live over SSE; nothing streams in this test.
class QuietEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close(): void {
    this.readyState = 2;
  }
}
const globals = {
  window: dom,
  document: dom.document,
  EventSource: QuietEventSource,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const originalFetch = globalThis.fetch;

afterAll(async () => {
  globalThis.fetch = originalFetch;
  invalidate('factory-views');
  invalidate('factory-workflow');
  invalidate('factory-items');
  invalidate('runs');
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
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
          // Holds every deliver step, so a step page opened without its stage would lead here.
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

let itemsResponse: (url: string) => Response = itemsReadAnswer([]);

function serve(items: (url: string) => Response): void {
  itemsResponse = items;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/factory/views')) return Response.json(views);
      if (url.includes('/api/factory/workflow')) return Response.json(deliver);
      if (isItemsRead(url)) return itemsResponse(url);
      if (url.includes('/api/runs/attention'))
        return Response.json({ items: [], runs: [], degraded: [] });
      return Response.json({ error: 'not in this test' }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect }
  );
  set(K.factoryViews(ID), views);
  set(K.factoryWorkflow(ID, 'deliver'), deliver);
  invalidate('factory-items');
}

const settle = (): Promise<void> => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

async function renderChecks(check: (container: HTMLElement) => Promise<void>): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[`/console/p/${ID}/factory?stage=checks`]}>
          <Routes>
            {/* As in ConsoleApp: every project page sits under the project layout, which holds
                the one attention stream (#42). */}
            <Route path="/console/p/:projectId" element={<ProjectAttentionLayout />}>
              <Route path="factory" element={<FactoryPage />} />
              <Route path="factory/steps/:workflow/:node" element={<StepPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      )
    );
    await settle();
    // The modal portals to the body, outside the root.
    await check(document.body as unknown as HTMLElement);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

const on = (key: string, step: string) =>
  capturedItemAs(key, {
    running: { runId: `run-${key}`, workflow: 'deliver', step, startedAt: '2026-11-17T07:00:00Z' },
  });

const phaseLabels = (root: Element): string[] =>
  [...root.querySelectorAll('[data-phase]')].map(phase => phase.getAttribute('aria-label') ?? '');
const liveCards = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('article[data-live]')].map(
    card => card.querySelector('a')?.textContent ?? ''
  );
/** A drill-down card's link: the first link of the card whose text reads `text`. */
const cardLink = (container: HTMLElement, text: string): HTMLAnchorElement => {
  const found = [...container.querySelectorAll('article > a')].find(candidate =>
    candidate.textContent.includes(text)
  );
  if (!(found instanceof dom.HTMLAnchorElement)) throw new Error(`No card reads ${text}`);
  return found as unknown as HTMLAnchorElement;
};
const click = async (target: HTMLElement): Promise<void> => {
  await act(async () => {
    target.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

test('the stage modal tells its drill-down: numbered phases of cards, one loop around 1 to 3', async () => {
  serve(itemsReadAnswer([]));
  await renderChecks(async container => {
    expect(phaseLabels(container)).toEqual([
      'Phase 1: Prepare',
      'Phase 2: Check',
      'Phase 3: Verdict',
      'Phase 4: Out of rounds',
    ]);
    const review = cardLink(container, 'Code review');
    expect(review.textContent).toContain("Reads the change for bugs and the project's rules");
    expect(review.textContent).toContain('Check');
    expect(container.querySelectorAll('article')).toHaveLength(7);
    const loops = [...container.querySelectorAll('[data-loop]')];
    expect(loops).toHaveLength(1);
    expect(loops[0]?.textContent).toContain('Up to 3 rounds');
    expect(phaseLabels(loops[0]!)).toEqual([
      'Phase 1: Prepare',
      'Phase 2: Check',
      'Phase 3: Verdict',
    ]);
    expect(liveCards(container)).toEqual([]);
  });
});

test('a card glows and names the items on a step it covers; a run between rounds lights the loop', async () => {
  serve(itemsReadAnswer([on('7', 'rounds.review__review')]));
  await renderChecks(async container => {
    expect(liveCards(container)).toEqual([expect.stringContaining('Code review')]);
    const lit = container.querySelector('article[data-live]');
    // It wears the step graph's running mark, its tint still its kind's colour.
    expect(lit?.className).toContain('factory-card');
    expect(lit?.hasAttribute('data-running')).toBe(true);
    expect((lit as HTMLElement | null)?.style.getPropertyValue('--card-tone')).not.toBe(
      'var(--running)'
    );
    // The items on it are links of their own, beside the card's link, never inside it.
    expect(
      [...(lit?.querySelectorAll(':scope > div a') ?? [])].map(link => link.getAttribute('href'))
    ).toEqual([`/console/p/${ID}/factory/items/7`]);
    expect(lit?.querySelector('a a')).toBeNull();
    expect(container.querySelector('[data-loop] > [data-live]')).toBeNull();

    itemsResponse = itemsReadAnswer([on('9', 'rounds')]);
    await act(async () => {
      invalidate('factory-items');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(liveCards(container)).toEqual([]);
    const label = container.querySelector('[data-loop] > [data-live]');
    expect(label?.textContent).toContain('Up to 3 rounds');
    expect(label?.getAttribute('title')).toBe('Between rounds: #9');

    // A label-ordered item reads the same: its key as #N, not issue-N.
    itemsResponse = itemsReadAnswer([on('issue-9', 'rounds')]);
    await act(async () => {
      invalidate('factory-items');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-loop] > [data-live]')?.getAttribute('title')).toBe(
      'Between rounds: #9'
    );
  });
});

test('a failed items read says so and lights no card', async () => {
  serve(itemsReadAnswer([on('7', 'rounds.review__review')]));
  await renderChecks(async container => {
    expect(liveCards(container)).toHaveLength(1);
    itemsResponse = () => Response.json({ error: 'The items read failed.' }, { status: 500 });
    await act(async () => {
      invalidate('factory-items');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain(
      'Could not refresh the items, so this stage shows the last ones read: The items read failed.'
    );
    expect(liveCards(container)).toEqual([]);
  });
});

test('a card is a link that looks it, and clicking it opens its step page back to the stage', async () => {
  serve(itemsReadAnswer([]));
  await renderChecks(async container => {
    const review = cardLink(container, 'Code review');
    expect(review.getAttribute('href')).toBe(
      `/console/p/${ID}/factory/steps/deliver/rounds.review__review`
    );
    // Its hover is `.factory-card`'s (theme.css) on the box, and a background on the link.
    expect(review.parentElement?.className).toContain('factory-card');
    expect(review.parentElement?.hasAttribute('data-link')).toBe(true);
    expect(review.className).toContain('cursor-pointer');
    expect(review.className).toContain('hover:bg-surface-elevated');
    expect(review.getAttribute('title')).toContain('rounds.review__review');
    // No panel of the card's steps opens below the phases: the card goes straight to its step.
    expect(container.textContent).not.toContain('The real steps');
    await click(review);
    expect(container.querySelector('[data-id-tag]')?.textContent).toBe('rounds.review__review');
    expect(container.textContent).toContain('Back to Checks');
  });
});

test('in the stage modal the tabs switch between the phases, the items and the real step graph', async () => {
  serve(itemsReadAnswer([]));
  await renderChecks(async container => {
    const graphStep = (): HTMLButtonElement | undefined =>
      [...container.querySelectorAll('button')].find(candidate =>
        candidate.textContent.startsWith('·fix')
      );
    const tab = (name: string): HTMLButtonElement => {
      const found = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        candidate => candidate.textContent === name
      );
      if (found === undefined) throw new Error(`No tab ${name}`);
      return found;
    };
    expect(phaseLabels(container)).toHaveLength(4);
    expect(graphStep()).toBeUndefined();
    await click(tab('The real workflow'));
    expect(graphStep()).toBeDefined();
    expect(phaseLabels(container)).toHaveLength(0);
    await click(tab('Items here now'));
    expect(container.textContent).toContain('Nothing is in this stage now.');
    expect(graphStep()).toBeUndefined();
    await click(tab('What this stage does'));
    expect(phaseLabels(container)).toHaveLength(4);
  });
});
