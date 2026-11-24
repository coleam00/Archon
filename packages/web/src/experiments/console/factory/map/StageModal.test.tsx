import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createMemoryRouter, NavigationType, RouterProvider } from 'react-router';
import { askItem } from '../../lib/needs-you.test-fixtures';
import type { FactoryItem } from '../../skills/factory';
import type { AttentionQueue } from '../../skills/runs';
import { ProjectAttentionProvider } from '../../components/ProjectAttention';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import { shippedListed } from '../item-detail.test-fixtures';
import deliverJson from '../lib/fixtures/deliver-workflow.json';
import { itemWith, realItem, run } from '../lib/map.test-fixtures';
import { FIXTURE_NOW } from '../lib/board.test-fixtures';
import { PILL_LABEL } from '../lib/board';
import { isItemsRead, itemsReadAnswer } from '../lib/fixtures/factory-items-page';
import { cancelRereads } from '../merge-reread';
import { cancelMergeWatches } from '../merge-watch';
import { FactoryMap } from './FactoryMap';

// Opening, closing, keys, focus and Back are events, which static markup cannot reach.
const dom = new Window({ url: 'http://localhost' });
/** The project's attention stream, which says nothing here. */
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

// The map sets aside items as the board does, idle ones by the clock: read the fixtures at the
// time they were copied, never at the day the test runs.
beforeAll(() => {
  setSystemTime(FIXTURE_NOW);
});
afterAll(() => {
  setSystemTime();
});
const originalFetch = globalThis.fetch;

/** What each workflow read gets, in turn; the last answer repeats. */
let workflowReads: (() => Response | Promise<Response>)[] = [];
let workflowFetches = 0;
/** The workflow each read asked for, in order. */
let workflowsAsked: string[] = [];
/** What the items read gets, for a test that leaves the items cold. */
let itemsAnswer: (url: string) => Response = itemsReadAnswer([]);
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (isItemsRead(url)) return itemsAnswer(url);
    if (!url.includes('/api/factory/workflow')) throw new Error(`the modal test fetched ${url}`);
    workflowsAsked.push(new URL(url, 'http://localhost').searchParams.get('workflow') ?? '');
    const answer = workflowReads[Math.min(workflowFetches, workflowReads.length - 1)];
    workflowFetches++;
    if (answer === undefined) throw new Error('no workflow answer set');
    return answer();
  },
  { preconnect: originalFetch.preconnect }
);
const offline = (): Response => {
  throw new TypeError('Failed to fetch');
};
const steps = (): Response => Response.json(deliverJson);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
afterEach(() => {
  cancelRereads();
  cancelMergeWatches();
  invalidate('factory-items');
  invalidate('factory-workflow');
  workflowReads = [steps];
  workflowFetches = 0;
  workflowsAsked = [];
});

const ID = 'cb-1';
const OVERVIEW = `/console/p/${ID}/factory`;
const asking = itemWith('9', [run('deliver', 'completed', 'ask')]);
const items = [realItem('5'), realItem('4'), realItem('7'), asking];
const queue: AttentionQueue = {
  items: [askItem({ item: { id: asking.item.id, projectKey: 'acme', key: '9' } })],
  runs: [],
  degraded: [],
};

type Listed = typeof shippedListed;
type ListedStage = Listed['declaration']['stages'][number];

/** The shipped view with stage `id` changed by `change`. */
function withStage(id: string, change: (stage: ListedStage) => ListedStage): Listed {
  const { declaration } = shippedListed;
  const stages = declaration.stages.map(stage => (stage.id === id ? change(stage) : stage));
  return { ...shippedListed, declaration: { ...declaration, stages } };
}

/**
 * Build listing stage-build alone: the read-retry rules below count one workflow's reads,
 * whatever the shipped Build lists.
 */
const oneBuildWorkflow = withStage('build', stage => ({ ...stage, workflows: ['stage-build'] }));

/** The map at `path`, in a router whose history a test can walk. */
async function mount(
  path = OVERVIEW,
  read: FactoryItem[] | null = items,
  view: Listed = shippedListed
) {
  // null leaves the items cold, so they are read through `itemsAnswer`.
  if (read !== null) set(K.factoryItems(ID), { items: read, members: {} });
  set(K.projectAttention(ID), queue);
  const router = createMemoryRouter(
    [
      {
        path: '/console/p/:projectId/factory',
        element: (
          <ProjectAttentionProvider projectId={ID}>
            <FactoryMap projectId={ID} view={view} />
          </ProjectAttentionProvider>
        ),
      },
    ],
    { initialEntries: [path] }
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  return {
    container,
    router,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const settle = (ms = 0): Promise<void> =>
  act(async () => new Promise(resolve => setTimeout(resolve, ms)));
const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"]');
const title = (): string | null | undefined => dialog()?.querySelector('h3')?.textContent;
const stageLink = (container: HTMLElement, stage: string): HTMLAnchorElement => {
  const link = container.querySelector<HTMLAnchorElement>(`a[data-stage="${stage}"]`);
  if (link === null) throw new Error(`No link for ${stage}`);
  return link;
};
const inDialog = (text: string): HTMLButtonElement => {
  const found = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    button => button.textContent === text || button.getAttribute('aria-label') === text
  );
  if (found === undefined) throw new Error(`No button ${text} in the dialog`);
  return found;
};
const click = async (target: HTMLElement): Promise<void> => {
  await act(async () => target.click());
};
/** A step of the drawn graph: each names its engine id on hover. */
const graphStep = (): Element | undefined =>
  dialog()?.querySelector('button[title*="engine id: rounds.fix"]') ?? undefined;

/** Opens Build from the map and shows its real workflow. */
async function openBuildWorkflow(container: HTMLElement): Promise<void> {
  await click(stageLink(container, 'build'));
  await click(inDialog('The real workflow'));
}

describe('a stage opened over the Overview', () => {
  test('a stage row opens it as a dialog named by the stage, with ?stage= in the URL', async () => {
    const { container, router, unmount } = await mount();
    try {
      expect(dialog()).toBeNull();
      await click(stageLink(container, 'plan'));
      expect(router.state.location.search).toBe('?stage=plan');
      expect(dialog()?.getAttribute('aria-modal')).toBe('true');
      const labelledBy = dialog()?.getAttribute('aria-labelledby') ?? '';
      expect(document.getElementById(labelledBy)?.textContent).toBe('Plan');
      // The map is still there under it.
      expect(container.querySelector('[data-card="plan-build"]')).not.toBeNull();
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    } finally {
      await unmount();
    }
  });

  test("Esc closes it and never reaches the map's own Esc, so its details panel stays open", async () => {
    const { container, router, unmount } = await mount();
    try {
      await click(container.querySelector<HTMLButtonElement>('[data-card="plan-build"] > button')!);
      expect(container.querySelector('aside[aria-label="Plan & build details"]')).not.toBeNull();
      await click(stageLink(container, 'build'));
      expect(title()).toBe('Build');
      await act(async () => {
        inDialog('Close').dispatchEvent(
          new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event
        );
      });
      expect(dialog()).toBeNull();
      expect(router.state.location.search).toBe('');
      expect(container.querySelector('aside[aria-label="Plan & build details"]')).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  test('a one-stage card opens it too; a press on the backdrop closes it, one in the panel does not', async () => {
    const { container, router, unmount } = await mount();
    try {
      // Ready is a card of one stage: the whole card is its link.
      expect(container.querySelector('[data-card="ready"] > a[data-stage="ready"]')).not.toBeNull();
      await click(stageLink(container, 'ready'));
      expect(router.state.location.search).toBe('?stage=ready');
      expect(title()).toBe('Ready to merge');
      const press = (target: Element): void => {
        target.dispatchEvent(
          new dom.MouseEvent('mousedown', { bubbles: true }) as unknown as Event
        );
      };
      await act(async () => press(dialog()!.querySelector('h3')!));
      expect(dialog()).not.toBeNull();
      await act(async () => press(document.querySelector('[data-backdrop]')!));
      expect(dialog()).toBeNull();
    } finally {
      await unmount();
    }
  });

  test('the close button closes it and gives focus back to the link that opened it', async () => {
    const { container, router, unmount } = await mount();
    try {
      const opener = stageLink(container, 'checks');
      opener.focus();
      await click(opener);
      expect(dialog()).not.toBeNull();
      await click(inDialog('Close'));
      expect(dialog()).toBeNull();
      expect(router.state.location.search).toBe('');
      expect(document.activeElement).toBe(opener);
    } finally {
      await unmount();
    }
  });

  test('Back closes it, and closing goes back rather than adding an entry', async () => {
    const { container, router, unmount } = await mount();
    try {
      await click(stageLink(container, 'checks'));
      expect(router.state.historyAction).toBe(NavigationType.Push);
      await act(async () => router.navigate(-1));
      expect(dialog()).toBeNull();
      expect(router.state.location.search).toBe('');
      await click(stageLink(container, 'checks'));
      await click(inDialog('Close'));
      expect(router.state.historyAction).toBe(NavigationType.Pop);
      expect(router.state.location.search).toBe('');
    } finally {
      await unmount();
    }
  });

  test('a pasted ?stage= link opens it; closing drops ?stage= in place', async () => {
    const { router, unmount } = await mount(`${OVERVIEW}?stage=checks`);
    try {
      expect(title()).toBe('Checks');
      await click(inDialog('Close'));
      expect(dialog()).toBeNull();
      expect(router.state.historyAction).toBe(NavigationType.Replace);
      expect(router.state.location.pathname).toBe(OVERVIEW);
      expect(router.state.location.search).toBe('');
    } finally {
      await unmount();
    }
  });

  test('a stage the factory does not have says so, and closes the same way', async () => {
    const { unmount } = await mount(`${OVERVIEW}?stage=nope`);
    try {
      expect(dialog()?.textContent).toContain('This factory has no stage nope.');
      await click(inDialog('Close'));
      expect(dialog()).toBeNull();
    } finally {
      await unmount();
    }
  });

  test('three plainly named tabs, each saying what it shows', async () => {
    const { container, unmount } = await mount();
    try {
      await click(stageLink(container, 'build'));
      const tabs = [...(dialog()?.querySelectorAll('[role="tab"]') ?? [])];
      expect(tabs.map(tab => tab.textContent)).toEqual([
        'What this stage does',
        'Items here now',
        'The real workflow',
      ]);
      expect(dialog()?.textContent).toContain(
        "The factory's summary of this stage, from its view file."
      );
      expect(dialog()?.querySelectorAll('[data-phase]').length).toBeGreaterThan(0);

      await click(inDialog('Items here now'));
      const rows = [...(dialog()?.querySelectorAll('li a') ?? [])];
      // The card's chip says 2 here; the list is the same two, each with its state.
      expect(rows.map(row => row.getAttribute('href'))).toEqual([
        `${OVERVIEW}/items/5`,
        `${OVERVIEW}/items/9`,
      ]);
      // Each with its state: the asking item says so; the running one names its run.
      expect(rows[1]?.textContent).toContain('Needs you');
      expect(rows[0]?.textContent).not.toContain('Needs you');
      expect(rows[0]?.textContent).toContain('Build · Writes the change');

      await click(inDialog('The real workflow'));
      expect(dialog()?.textContent).toContain(
        "Generated from the pack's workflow files; shows every step."
      );
      await settle();
      expect(graphStep()).toBeDefined();
      expect(dialog()?.textContent).not.toMatch(/Drill-down|Real steps/);
      // Every step is a link to its page and looks it: a pointer, a hover background, and the
      // hover border theme.css keys on `data-step-node`.
      const drawn = [...(dialog()?.querySelectorAll('button[data-step-node]') ?? [])];
      expect(drawn.length).toBeGreaterThan(0);
      for (const step of drawn) {
        expect(step.className).toContain('cursor-pointer');
        expect(step.className).toContain('hover:bg-surface-hover');
        expect(step.className).not.toContain('brightness');
      }
    } finally {
      await unmount();
    }
  });

  test('an item no run works and no ask holds says its state in Items here now', async () => {
    const { container, unmount } = await mount();
    try {
      await click(stageLink(container, 'landed'));
      await click(inDialog('Items here now'));
      const rows = [...(dialog()?.querySelectorAll('li a') ?? [])];
      expect(rows).toHaveLength(1);
      // The row's last line is its state, in the board card's word.
      expect(rows[0]?.lastElementChild?.textContent).toBe(PILL_LABEL.landed);
    } finally {
      await unmount();
    }
  });

  test('a stage with no summary and no workflow does not point at an empty tab', async () => {
    // Merged, given no workflow and no drill-down (the shipped one has the pack's `landed`).
    const bare = withStage('landed', ({ drilldown: _drilldown, ...stage }) => ({
      ...stage,
      workflows: [],
    }));
    const { container, unmount } = await mount(OVERVIEW, items, bare);
    try {
      await click(stageLink(container, 'landed'));
      await click(inDialog('What this stage does'));
      expect(dialog()?.textContent).toContain(
        'This stage has no summary and no workflow runs in it.'
      );
      expect(dialog()?.textContent).not.toContain('The real workflow shows its steps');
    } finally {
      await unmount();
    }
  });

  test("a workflow's name in a card's details opens the stage on its real workflow", async () => {
    const { container, unmount } = await mount();
    try {
      await click(container.querySelector<HTMLButtonElement>('[data-card="plan-build"] > button')!);
      const chip = [
        ...container.querySelectorAll<HTMLAnchorElement>(
          'aside[aria-label="Plan & build details"] li a'
        ),
      ].find(link => link.textContent === 'stage-build');
      await click(chip!);
      expect(title()).toBe('Build');
      expect(dialog()?.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
        'The real workflow'
      );
    } finally {
      await unmount();
    }
  });

  test('a stage draws and reads only the workflows the pack runs now, never the retired deliver', async () => {
    expect(shippedListed.declaration.retired).toEqual(['deliver']);
    const { container, unmount } = await mount();
    try {
      for (const stage of ['build', 'checks', 'host']) {
        await click(stageLink(container, stage));
        await click(inDialog('The real workflow'));
        await settle();
        expect(dialog()?.textContent).not.toContain('deliver');
        await click(inDialog('Close'));
      }
      // Each stage's one current workflow, read once; deliver, which still places their old
      // items, is never asked for.
      expect(workflowsAsked).toEqual(['stage-build', 'stage-check', 'stage-host']);
    } finally {
      await unmount();
    }
  });

  test("its head lists where items go from the stage, in the view file's words", async () => {
    const { unmount } = await mount(`${OVERVIEW}?stage=build`);
    try {
      const list = dialog()?.querySelector('[aria-label="Where items go from here"]');
      expect(list?.querySelector('h4')?.textContent).toBe('Where items go from here');
      // Every arrow out of Build, the map's "built +2" among them; not its own "answers".
      expect([...(list?.querySelectorAll('li') ?? [])].map(li => li.textContent)).toEqual([
        'built → Checks',
        'fixed for CI → CI and review',
        'replan → Plan',
        'drop or reshape → Ready to merge',
      ]);
      // It sits in the head, so it stays put on every tab.
      await click(inDialog('Items here now'));
      expect(dialog()?.querySelector('[aria-label="Where items go from here"]')).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  test('a failed items read says why in Items here now, and Retry reads them again', async () => {
    itemsAnswer = () => Response.json({ error: 'The items read failed.' }, { status: 500 });
    const { container, unmount } = await mount(`${OVERVIEW}?stage=build`, null);
    try {
      await settle();
      await click(inDialog('Items here now'));
      const alert = dialog()?.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('The items read failed.');
      itemsAnswer = itemsReadAnswer(items);
      await click(inDialog('Retry'));
      await settle();
      expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
      expect(dialog()?.querySelectorAll('li a[href*="/items/"]').length).toBeGreaterThan(0);
      expect(container.querySelector('[data-card="plan-build"]')).not.toBeNull();
    } finally {
      itemsAnswer = itemsReadAnswer([]);
      await unmount();
    }
  });

  test('a failed refresh after a good read says so once, above every tab, and Retry reads again', async () => {
    const { container, unmount } = await mount(`${OVERVIEW}?stage=build`);
    const alerts = (): string[] =>
      [...(dialog()?.querySelectorAll('[role="alert"]') ?? [])].map(alert => alert.textContent);
    try {
      await click(inDialog('Items here now'));
      const shown = dialog()?.querySelectorAll('li a[href*="/items/"]').length ?? 0;
      expect(shown).toBeGreaterThan(0);
      expect(alerts()).toEqual([]);
      // The read the dashboard's events start, failing: the cache keeps the last list.
      itemsAnswer = () => Response.json({ error: 'The refresh failed.' }, { status: 500 });
      await act(async () => {
        invalidate('factory-items');
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      const stale = [
        'Could not refresh the items, so this stage shows the last ones read: The refresh failed.Retry',
      ];
      // The old items stay drawn, under the one notice that says they are old.
      expect(alerts()).toEqual(stale);
      expect(dialog()?.querySelectorAll('li a[href*="/items/"]').length).toBe(shown);
      // Every tab reads under the same notice, and none adds its own.
      for (const tab of ['What this stage does', 'The real workflow']) {
        await click(inDialog(tab));
        await settle();
        expect(alerts()).toEqual(stale);
      }
      itemsAnswer = itemsReadAnswer(items);
      await click(inDialog('Retry'));
      await settle();
      expect(alerts()).toEqual([]);
      expect(container.querySelector('[data-card="plan-build"]')).not.toBeNull();
    } finally {
      itemsAnswer = itemsReadAnswer([]);
      await unmount();
    }
  });

  test('a stage with nothing in it says so and points at the board', async () => {
    const { container, unmount } = await mount(OVERVIEW, []);
    try {
      await click(stageLink(container, 'plan'));
      await click(inDialog('Items here now'));
      expect(dialog()?.textContent).toContain('Nothing is in this stage now.');
      expect(dialog()?.querySelector(`a[href="${OVERVIEW}/board"]`)).not.toBeNull();
    } finally {
      await unmount();
    }
  });
});

describe('the workflow read never dead-ends', () => {
  test('a network failure is tried once more, and the graph draws with no alert', async () => {
    workflowReads = [offline, steps];
    const { container, unmount } = await mount(OVERVIEW, items, oneBuildWorkflow);
    try {
      await openBuildWorkflow(container);
      // The skeleton holds the place while the read and its retry run.
      expect(dialog()?.querySelector('[data-skeleton]')?.textContent).toContain(
        'Loading the steps'
      );
      await settle(1_100);
      expect(workflowFetches).toBe(2);
      expect(graphStep()).toBeDefined();
      expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await unmount();
    }
  });

  test('two failures say what failed with a Retry button, and Retry draws the graph', async () => {
    workflowReads = [offline, offline, steps];
    const { container, unmount } = await mount(OVERVIEW, items, oneBuildWorkflow);
    try {
      await openBuildWorkflow(container);
      await settle(1_100);
      const alert = dialog()?.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(
        'Could not read the workflow stage-build: the server did not answer'
      );
      await click(inDialog('Retry'));
      expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
      await settle();
      expect(workflowFetches).toBe(3);
      expect(graphStep()).toBeDefined();
    } finally {
      await unmount();
    }
  });

  test("the server's own refusal is not retried and shows its message", async () => {
    workflowReads = [
      () =>
        Response.json({ error: 'This pack has no workflow named stage-build.' }, { status: 404 }),
    ];
    const { container, unmount } = await mount(OVERVIEW, items, oneBuildWorkflow);
    try {
      await openBuildWorkflow(container);
      await settle();
      expect(workflowFetches).toBe(1);
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not read the workflow stage-build: This pack has no workflow named stage-build.'
      );
    } finally {
      await unmount();
    }
  });

  test('a stage opened again after a failure reads again, without the old alert', async () => {
    let answer: () => void = () => {};
    // The read on reopening waits, so what shows while it runs can be seen.
    const held = (): Promise<Response> =>
      new Promise(resolve => {
        answer = () => resolve(steps());
      });
    workflowReads = [offline, offline, held];
    const { container, unmount } = await mount(OVERVIEW, items, oneBuildWorkflow);
    try {
      await openBuildWorkflow(container);
      await settle(1_100);
      expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();
      await click(inDialog('Close'));
      await openBuildWorkflow(container);
      expect(workflowFetches).toBe(3);
      expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
      expect(dialog()?.querySelector('[data-skeleton]')?.textContent).toContain(
        'Loading the steps'
      );
      answer();
      await settle();
      expect(graphStep()).toBeDefined();
    } finally {
      await unmount();
    }
  });
});

describe('the modal layout', () => {
  test('the title and tabs stay outside the scrolling body', async () => {
    const { container, unmount } = await mount();
    try {
      await click(stageLink(container, 'checks'));
      const body = dialog()?.querySelector('[data-modal-body]');
      expect(body?.querySelector('[data-phase]')).not.toBeNull();
      expect(dialog()?.querySelector('[role="tablist"]')).not.toBeNull();
      expect(body?.querySelector('[role="tablist"]')).toBeNull();
      expect(body?.querySelector('h3')).toBeNull();
    } finally {
      await unmount();
    }
  });
});
