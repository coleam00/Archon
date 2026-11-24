import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
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
import { installDom } from '../../test-dom.test-helpers';
import { FactoryMap } from './FactoryMap';

// Opening, closing, keys, focus and Back are events, which static markup cannot reach.
const { dom, mount: mountTree } = await installDom();

// The map sets aside items as the board does, idle ones by the clock: read the fixtures at the
// time they were copied, never at the day the test runs.
beforeAll(() => {
  setSystemTime(FIXTURE_NOW);
});
afterAll(() => {
  setSystemTime();
});
const originalFetch = globalThis.fetch;

/** What the items read gets, for a test that leaves the items cold. */
let itemsAnswer: (url: string) => Response = itemsReadAnswer([]);
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (isItemsRead(url)) return itemsAnswer(url);
    if (!url.includes('/api/factory/workflow')) throw new Error(`the modal test fetched ${url}`);
    return Response.json(deliverJson);
  },
  { preconnect: originalFetch.preconnect }
);

afterEach(() => {
  cancelRereads();
  cancelMergeWatches();
  invalidate('factory-items');
  invalidate('factory-workflow');
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

/** The map at `path`, in a router whose history a test can walk. */
async function mount(path = OVERVIEW, read: FactoryItem[] | null = items) {
  // null leaves the items cold, so they are read through `itemsAnswer`.
  if (read !== null) set(K.factoryItems(ID), { items: read, members: {} });
  set(K.projectAttention(ID), queue);
  const router = createMemoryRouter(
    [
      {
        path: '/console/p/:projectId/factory',
        element: (
          <ProjectAttentionProvider projectId={ID}>
            <FactoryMap projectId={ID} view={shippedListed} />
          </ProjectAttentionProvider>
        ),
      },
    ],
    { initialEntries: [path] }
  );
  return { ...(await mountTree(<RouterProvider router={router} />)), router };
}

const settle = (): Promise<void> => act(async () => new Promise(resolve => setTimeout(resolve, 0)));
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

describe('a stage opened over the Overview', () => {
  test('a stage row opens a dialog over the map; Esc and the backdrop close it, Close returns focus', async () => {
    const { container, router, unmount } = await mount();
    try {
      // The card's details panel is open under it; the dialog's Esc must not reach the map's.
      await click(container.querySelector<HTMLButtonElement>('[data-card="plan-build"] > button')!);
      await click(stageLink(container, 'plan'));
      expect(router.state.location.search).toBe('?stage=plan');
      expect(dialog()?.getAttribute('aria-modal')).toBe('true');
      const labelledBy = dialog()?.getAttribute('aria-labelledby') ?? '';
      expect(document.getElementById(labelledBy)?.textContent).toBe('Plan');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
      await act(async () => {
        inDialog('Close').dispatchEvent(
          new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event
        );
      });
      expect(dialog()).toBeNull();
      expect(router.state.location.search).toBe('');
      expect(container.querySelector('aside[aria-label="Plan & build details"]')).not.toBeNull();

      // A one-stage card is its link; a press on the backdrop closes it.
      await click(stageLink(container, 'ready'));
      expect(title()).toBe('Ready to merge');
      const press = (target: Element): Promise<void> =>
        act(async () => {
          target.dispatchEvent(
            new dom.MouseEvent('mousedown', { bubbles: true }) as unknown as Event
          );
        });
      await press(document.querySelector('[data-backdrop]')!);
      expect(dialog()).toBeNull();

      const opener = stageLink(container, 'checks');
      opener.focus();
      await click(opener);
      await click(inDialog('Close'));
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(opener);
    } finally {
      await unmount();
    }
  });

  test('Back closes it and closing goes back; a pasted ?stage= closes in place', async () => {
    const opened = await mount();
    try {
      const { container, router } = opened;
      await click(stageLink(container, 'checks'));
      await act(async () => router.navigate(-1));
      expect(dialog()).toBeNull();
      await click(stageLink(container, 'checks'));
      await click(inDialog('Close'));
      expect(router.state.historyAction).toBe(NavigationType.Pop);
    } finally {
      await opened.unmount();
    }
    const pasted = await mount(`${OVERVIEW}?stage=checks`);
    try {
      await click(inDialog('Close'));
      expect(pasted.router.state.historyAction).toBe(NavigationType.Replace);
      expect(pasted.router.state.location.search).toBe('');
    } finally {
      await pasted.unmount();
    }
  });

  test('three tabs: the summary with where items go, the items here with their state, the real workflow', async () => {
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
      // The head lists every arrow out of Build, the map's "built +2" among them; not "answers".
      const goes = (): Element | null | undefined =>
        dialog()?.querySelector('[aria-label="Where items go from here"]');
      expect([...(goes()?.querySelectorAll('li') ?? [])].map(li => li.textContent)).toEqual([
        'built → Checks',
        'fixed for CI → CI and review',
        'replan → Plan',
        'drop or reshape → Ready to merge',
      ]);

      await click(inDialog('Items here now'));
      expect(goes()).not.toBeNull();
      const rows = [...(dialog()?.querySelectorAll('li a') ?? [])];
      // The card's chip says 2 here; the list is the same two, each with its state.
      expect(rows.map(row => row.getAttribute('href'))).toEqual([
        `${OVERVIEW}/items/5`,
        `${OVERVIEW}/items/9`,
      ]);
      expect(rows[1]?.textContent).toContain('Needs you');
      expect(rows[0]?.textContent).not.toContain('Needs you');
      expect(rows[0]?.textContent).toContain('Build · Writes the change');

      await click(inDialog('The real workflow'));
      await settle();
      expect(graphStep()).toBeDefined();
      await click(inDialog('Close'));

      // An item no run works says its state in the board card's word.
      await click(stageLink(container, 'landed'));
      await click(inDialog('Items here now'));
      const merged = [...(dialog()?.querySelectorAll('li a') ?? [])];
      expect(merged).toHaveLength(1);
      expect(merged[0]?.lastElementChild?.textContent).toBe(PILL_LABEL.landed);
    } finally {
      await unmount();
    }
  });

  test('a stage with nothing in it points at the board', async () => {
    const empty = await mount(OVERVIEW, []);
    try {
      await click(stageLink(empty.container, 'plan'));
      await click(inDialog('Items here now'));
      expect(dialog()?.textContent).toContain('Nothing is in this stage now.');
      expect(dialog()?.querySelector(`a[href="${OVERVIEW}/board"]`)).not.toBeNull();
    } finally {
      await empty.unmount();
    }
  });

  test('a failed items read says why in Items here now, and Retry reads them again', async () => {
    itemsAnswer = () => Response.json({ error: 'The items read failed.' }, { status: 500 });
    const { unmount } = await mount(`${OVERVIEW}?stage=build`, null);
    try {
      await settle();
      await click(inDialog('Items here now'));
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
        'The items read failed.'
      );
      itemsAnswer = itemsReadAnswer(items);
      await click(inDialog('Retry'));
      await settle();
      expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
      expect(dialog()?.querySelectorAll('li a[href*="/items/"]').length).toBeGreaterThan(0);
    } finally {
      itemsAnswer = itemsReadAnswer([]);
      await unmount();
    }
  });
});
