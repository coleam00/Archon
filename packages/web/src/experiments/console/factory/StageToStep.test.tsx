import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { MemoryRouter, Routes } from 'react-router';
import type { FactoryViews, FactoryWorkflow } from '../skills/factory';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import { projectRoutes } from '../routes/project-routes';
import deliverJson from './lib/fixtures/deliver-workflow.json';
import {
  capturedItemAs,
  capturedItemsPage,
  isItemsRead,
  itemsReadAnswer,
} from './lib/fixtures/factory-items-page';

// Clicking a step is the only way onto a step page, and static markup cannot click.
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
          {
            id: 'checks',
            label: 'Checks',
            blurb: 'Checks the change.',
            group: 'check',
            workflows: ['deliver'],
            nodes: ['rounds.review__review'],
          },
        ],
        placement: {},
        endings: {},
        landed: { stage: 'checks' },
        map: { cards: [], arrows: [] },
      },
    },
  ],
  errors: [],
};

/** What each workflow read gets, in turn, the last repeating; a test sets it to fail first. */
let workflowAnswers: (() => Response)[] = [() => Response.json(deliverJson)];
let workflowFetches = 0;

/** What the stubbed server answers for the items read; a test swaps it to move an item. */
let itemsResponse: (url: string) => Response = itemsReadAnswer(capturedItemsPage.items);

// The pages read through the cache; a revalidation gets the same answers.
function serve(items: (url: string) => Response): void {
  itemsResponse = items;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/factory/views')) return Response.json(views);
      if (url.includes('/api/factory/workflow')) {
        const answer = workflowAnswers[Math.min(workflowFetches, workflowAnswers.length - 1)];
        workflowFetches++;
        return answer!();
      }
      if (isItemsRead(url)) return itemsResponse(url);
      if (url.includes('/api/runs/attention'))
        return Response.json({ items: [], runs: [], degraded: [] });
      return Response.json({ error: 'not in this test' }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect }
  );
  set(K.factoryViews(ID), views);
  set(K.factoryWorkflow(ID, 'deliver'), deliver);
  // Each test starts from a cold items read, so it loads what this test serves.
  invalidate('factory-items');
}

const settle = (): Promise<void> => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

async function renderAt(
  path: string,
  check: (container: HTMLElement) => Promise<void>
): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>{projectRoutes('/console/')}</Routes>
        </MemoryRouter>
      )
    );
    await settle();
    // The stage modal portals to the body, outside the root.
    await check(document.body as unknown as HTMLElement);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

function stepButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(candidate =>
    candidate.textContent.startsWith(label)
  );
  if (!button) throw new Error(`The stage graph drew no ${label} step`);
  return button;
}

/** The item links on the page, or in the stage modal when it is open over the map's own. */
const itemLinks = (container: HTMLElement): string[] =>
  [
    ...(container.querySelector('[role="dialog"]') ?? container).querySelectorAll(
      'a[href*="/factory/items/"]'
    ),
  ].map(link => link.getAttribute('href') ?? '');

// Newest activity first: #4's run started after #12's.
const capturedLinks = ['4', '12', '6'].map(key => `/console/p/${ID}/factory/items/${key}`);

test('clicking a step on the stage graph opens its step page, which leads back to the stage', async () => {
  serve(itemsReadAnswer(capturedItemsPage.items));
  await renderAt(`/console/p/${ID}/factory?stage=checks`, async container => {
    const fix = stepButton(container, '·fix');
    await act(async () => {
      fix.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-id-tag]')?.textContent).toBe('rounds.fix');
    expect(container.textContent).toContain('Back to Checks');
  });
});

test('a stage with no drill-down opens on its real workflow', async () => {
  serve(itemsReadAnswer(capturedItemsPage.items));
  await renderAt(`/console/p/${ID}/factory?stage=checks`, async container => {
    expect(stepButton(container, '·fix')).toBeDefined();
    const selected = container.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe('The real workflow');
  });
});

test('the stage modal glows the step items are on now and links each item', async () => {
  serve(itemsReadAnswer(capturedItemsPage.items));
  await renderAt(`/console/p/${ID}/factory?stage=checks`, async container => {
    expect(container.textContent).toContain('Running now');
    expect(itemLinks(container)).toEqual(capturedLinks);
    // Another stage works build__build; a step an item is on glows whichever stage works it.
    const build = stepButton(container, '·build');
    expect(build.hasAttribute('data-running')).toBe(true);
    expect(build.className).not.toContain('opacity-60');
    expect(build.title).toContain('Running for #4, #12, #6');
    expect(stepButton(container, '·fix').hasAttribute('data-running')).toBe(false);
  });
});

test('the step page draws the items on the step now as board cards, and says when there are none', async () => {
  serve(itemsReadAnswer(capturedItemsPage.items));
  await renderAt(`/console/p/${ID}/factory/steps/deliver/build__build`, async container => {
    expect(container.textContent).toContain('Items on this step now');
    expect(
      [...container.querySelectorAll('[data-card]')].map(card => card.getAttribute('data-card'))
    ).toEqual(['4', '12', '6']);
    // Each card's own link to its item, in the read's order (a card may link its item twice).
    expect([...new Set(itemLinks(container))]).toEqual(capturedLinks);
  });
  await renderAt(`/console/p/${ID}/factory/steps/deliver/rounds.fix`, async container => {
    expect(itemLinks(container)).toEqual([]);
    expect(container.textContent).toContain('No item is on this step now.');
  });
});

test("the step page's YAML pane reads at the type floor: its label and Copy at 12 px", async () => {
  serve(itemsReadAnswer(capturedItemsPage.items));
  await renderAt(`/console/p/${ID}/factory/steps/deliver/build__build`, async container => {
    const label = [...container.querySelectorAll('span')].find(
      span => span.textContent === 'YAML · read-only'
    );
    const pane = label?.closest('header');
    expect(pane?.querySelector('button')?.textContent).toBe('Copy');
    // The pane's header: nothing in it under the floor, and both its texts at 12 px.
    expect(pane?.innerHTML).not.toMatch(/text-console-(9|10|11)\b/);
    expect(label?.className).toContain('text-console-12');
    expect(pane?.querySelector('button')?.className).toContain('text-console-12');
  });
});

test('a dashboard event moves an item onto the step page it is now on', async () => {
  serve(itemsReadAnswer(capturedItemsPage.items));
  await renderAt(`/console/p/${ID}/factory/steps/deliver/rounds.fix`, async container => {
    expect(container.textContent).toContain('No item is on this step now.');
    const moved = capturedItemAs('12', {
      running: {
        runId: 'c9773ff3-36bf-413e-a3b3-45ce93a77087',
        workflow: 'deliver',
        step: 'rounds.fix',
        startedAt: '2026-11-17T06:41:56.000Z',
      },
    });
    itemsResponse = itemsReadAnswer([moved]);
    // What lib/sse.ts calls on a workflow_status or dag_node event.
    await act(async () => {
      invalidate('factory-items');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(itemLinks(container)).toEqual([`/console/p/${ID}/factory/items/12`]);
  });
});

test('a failed refresh says so in the stage modal and stops the glow; the graph still draws', async () => {
  serve(itemsReadAnswer(capturedItemsPage.items));
  await renderAt(`/console/p/${ID}/factory?stage=checks`, async container => {
    expect(stepButton(container, '·build').hasAttribute('data-running')).toBe(true);
    itemsResponse = () => Response.json({ error: 'The items read failed.' }, { status: 500 });
    await act(async () => {
      invalidate('factory-items');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain(
      'Could not refresh the items, so this stage shows the last ones read: The items read failed.'
    );
    // The cache keeps the last list; it no longer says what runs.
    expect(stepButton(container, '·build').hasAttribute('data-running')).toBe(false);
    expect(itemLinks(container)).toEqual([]);
  });
});

test('a run between loop bodies lights the loop frame', async () => {
  const between = capturedItemAs('issue-9', {
    running: {
      runId: 'run-issue-9',
      workflow: 'deliver',
      step: 'rounds',
      startedAt: '2026-11-17T07:00:00.000Z',
    },
  });
  serve(itemsReadAnswer([between]));
  await renderAt(`/console/p/${ID}/factory?stage=checks`, async container => {
    const lit = [...container.querySelectorAll('div[data-running]')];
    expect(lit.map(frame => frame.textContent)).toEqual([expect.stringContaining('rounds')]);
    expect(lit[0]?.getAttribute('title')).toBe('Running for #9');
    expect(container.querySelectorAll('button[data-running]')).toHaveLength(0);
  });
});

test("a step's back link opens its stage over the Overview, where it came from", async () => {
  serve(itemsReadAnswer([]));
  await renderAt(`/console/p/${ID}/factory?stage=checks`, async container => {
    await act(async () => {
      stepButton(container, '·fix').click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const back = container.querySelector<HTMLAnchorElement>('a[data-back-link]');
    expect(back?.textContent).toBe('Back to Checks');
    await act(async () => {
      back?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[role="dialog"] h3')?.textContent).toBe('Checks');
  });
});

test('the step page tries its workflow read again, and Retry reads it after two failures', async () => {
  serve(itemsReadAnswer([]));
  invalidate('factory-workflow');
  const offline = (): Response => {
    throw new TypeError('Failed to fetch');
  };
  workflowAnswers = [offline, offline, () => Response.json(deliverJson)];
  workflowFetches = 0;
  try {
    await renderAt(`/console/p/${ID}/factory/steps/deliver/rounds.fix`, async container => {
      await act(async () => new Promise(resolve => setTimeout(resolve, 1_100)));
      expect(workflowFetches).toBe(2);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('deliver');
      expect(alert?.textContent).toContain('the server did not answer');
      await act(async () => {
        alert?.querySelector('button')?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      await settle();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain('From command fix');
    });
  } finally {
    workflowAnswers = [() => Response.json(deliverJson)];
  }
});
