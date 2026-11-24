import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router';
import type { AttentionQueue } from '../../skills/runs';
import { ProjectAttentionProvider } from '../../components/ProjectAttention';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import type { FactoryItem } from '../../skills/factory';
import { shippedListed } from '../item-detail.test-fixtures';
import { itemWith, realItem, run } from '../lib/map.test-fixtures';
import { FIXTURE_NOW } from '../lib/board.test-fixtures';
import { askItem } from '../../lib/needs-you.test-fixtures';
import { isItemsRead, itemsReadAnswer } from '../lib/fixtures/factory-items-page';
import type { FactoryViewListed } from '../lib/views';
import { cancelRereads } from '../merge-reread';
import { cancelMergeWatches } from '../merge-watch';
import { installDom } from '../../test-dom.test-helpers';
import { FactoryMap } from './FactoryMap';

// Opening a card's stage or its details needs clicks, which static markup cannot reach.
const { dom, mount: mountTree } = await installDom();

// The map sets aside items as the board does, idle ones by the clock: read the fixtures at the
// time they were copied, never at the day the test runs.
beforeAll(() => {
  setSystemTime(FIXTURE_NOW);
});
afterAll(() => {
  setSystemTime();
});

afterEach(() => {
  cancelRereads();
  cancelMergeWatches();
  invalidate('factory-items');
});

const ID = 'cb-1';
const asking = itemWith('9', [run('deliver', 'completed', 'ask')]);
const items = [realItem('5'), realItem('4'), realItem('7'), asking];
const queue: AttentionQueue = {
  items: [askItem({ item: { id: asking.item.id, projectKey: 'acme', key: '9' } })],
  runs: [],
  degraded: [],
};

/** The stage the URL opens over the map, for the tests to read. */
function OpenStage(): React.ReactElement | null {
  const stage = useSearchParams()[0].get('stage');
  return stage === null ? null : <p data-testid="stage-page">{stage}</p>;
}

/** The map over `read`, seeded warm in the cache; null leaves the cache cold, so it fetches. */
async function mount(
  read: FactoryItem[] | null = items,
  listed: FactoryViewListed = shippedListed
): ReturnType<typeof mountTree> {
  if (read !== null) set(K.factoryItems(ID), { items: read, members: {} });
  set(K.projectAttention(ID), queue);
  return mountTree(
    <MemoryRouter initialEntries={[`/console/p/${ID}/factory`]}>
      <Routes>
        <Route
          path="/console/p/:projectId/factory"
          element={
            <ProjectAttentionProvider projectId={ID}>
              <FactoryMap projectId={ID} view={listed} />
              <OpenStage />
            </ProjectAttentionProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

/** A stage's link: the card of a one-stage card, or its row in a card of several. */
const card = (container: HTMLElement, stage: string): HTMLAnchorElement => {
  const link = container.querySelector<HTMLAnchorElement>(`a[data-stage="${stage}"]`);
  if (link === null) throw new Error(`No card for ${stage}`);
  return link;
};
/** A card's details button, beside its links. */
const details = (container: HTMLElement, id: string): HTMLButtonElement => {
  const button = container.querySelector<HTMLButtonElement>(`[data-card="${id}"] > button`);
  if (button === null) throw new Error(`No details button for ${id}`);
  return button;
};
/** The hover text of the shadow badge by a stage's name on the map. */
const shadowTitle = (container: HTMLElement, stage: string): string | null | undefined =>
  container.querySelector(`[data-stage="${stage}"] [data-shadow-badge]`)?.getAttribute('title');
const stagePage = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[data-testid="stage-page"]')?.textContent;

/** The "N here" chip a card draws; null when it draws none (nothing there). */
const hereChip = (container: HTMLElement, stage: string): string | null =>
  container.querySelector(`[data-stage="${stage}"] [data-chip="here"]`)?.textContent ?? null;
const hrefs = (root: Element | null | undefined, selector: string): (string | null)[] =>
  [...(root?.querySelectorAll(selector) ?? [])].map(link => link.getAttribute('href'));
const stageHref = (stage: string): string => `/console/p/${ID}/factory?stage=${stage}`;

test('the warm map: a card per column with its chips, rows, hand-offs and details panel; a click opens the stage', async () => {
  const { container, unmount } = await mount();
  try {
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-card]')].map(el => el.dataset.card)
    ).toEqual(['intake', 'plan-build', 'checks-review', 'ready', 'merged']);
    expect(hrefs(container.querySelector('[data-card="plan-build"]'), 'a[data-stage]')).toEqual([
      stageHref('plan'),
      stageHref('build'),
    ]);
    expect(card(container, 'build').getAttribute('aria-label')).toBe(
      'Build: 2 here, 1 being worked, 1 needs you'
    );
    expect(card(container, 'checks').getAttribute('aria-label')).toBe(
      'Checks: 1 here, 1 being worked'
    );
    expect(card(container, 'landed').getAttribute('aria-label')).toBe('Merged: 1 here');
    const chip = (stage: string, kind: string): string | null | undefined =>
      container.querySelector(`[data-stage="${stage}"] [data-chip="${kind}"]`)?.textContent;
    expect(chip('build', 'here')).toContain('2');
    expect(chip('build', 'need-you')).toContain('1');
    expect(chip('checks', 'need-you')).toBeUndefined();
    expect(chip('plan', 'here')).toBeUndefined();
    // A dot runs into each card where a run works an item.
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-flow]')].map(el => el.dataset.flow)
    ).toEqual(['plan-build', 'checks-review']);
    // Hand-off pills between neighbours, and one send-back lane pill per target stage.
    expect([...container.querySelectorAll('g[data-arrow]')].map(g => g.textContent)).toEqual([
      'build,narrow',
      'built +2',
      'ready,drop or reshape',
      'merged',
    ]);
    expect(
      [...container.querySelectorAll('g[data-lane-pill]')].map(
        g => `${g.getAttribute('data-lane-pill') ?? ''}: ${g.textContent ?? ''}`
      )
    ).toEqual([
      'order: pieces, broke the branch',
      'triage: split',
      'plan: replan, answers',
      'build: returned, sent back, answers',
      'ready: land, drop or reshape',
    ]);

    // The details button opens a panel over the map without leaving it.
    await act(async () => details(container, 'plan-build').click());
    const panel = container.querySelector('aside[aria-label="Plan & build details"]');
    // Build's retired deliver still places old items but is not offered as a workflow.
    expect(hrefs(panel, 'li a')).toEqual([
      stageHref('plan'),
      `/console/p/${ID}/factory/items/5`,
      `/console/p/${ID}/factory/items/9`,
      stageHref('build'),
    ]);
    expect(panel?.textContent).toContain('Needs you');
    expect(panel?.textContent).toContain('Build · Writes the change');
    expect(details(container, 'plan-build').getAttribute('aria-pressed')).toBe('true');
    expect(stagePage(container)).toBeUndefined();
    await act(async () => details(container, 'plan-build').click());
    expect(container.querySelector('aside')).toBeNull();

    await act(async () => card(container, 'checks').click());
    expect(stagePage(container)).toBe('checks');
  } finally {
    await unmount();
  }
});

test('while a merge state is pending, Ready to merge and Merged say they are checking, not a count', async () => {
  const pending = itemWith('p', [run('deliver', 'completed', 'ready')], 'pending');
  const { container, unmount } = await mount([realItem('7'), realItem('5'), pending]);
  try {
    for (const stage of ['ready', 'landed']) {
      expect(hereChip(container, stage)).toBeNull();
      expect(
        container.querySelector(`[data-stage="${stage}"] [data-chip="checking"]`)?.textContent
      ).toBe('checking…');
    }
    expect(card(container, 'landed').getAttribute('aria-label')).toBe(
      'Merged: checking merge state'
    );
    expect(hereChip(container, 'build')).toContain('1');
  } finally {
    await unmount();
  }
});

test('a drag that ends on a card pans the map and does not open the card', async () => {
  const { container, unmount } = await mount();
  try {
    const target = card(container, 'build');
    // The pan is the layer's transform; a drag moves it.
    const layer = () => container.querySelector<HTMLElement>('[style*="scale("]')?.style.transform;
    const before = layer();
    const pointer = (type: string, init: Record<string, number>): Event =>
      new dom.PointerEvent(type, { bubbles: true, cancelable: true, ...init }) as unknown as Event;
    await act(async () => {
      target.dispatchEvent(
        pointer('pointerdown', { button: 0, buttons: 1, pointerId: 1, clientX: 100, clientY: 100 })
      );
      target.dispatchEvent(
        pointer('pointermove', { buttons: 1, pointerId: 1, clientX: 140, clientY: 100 })
      );
      target.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 140, clientY: 100 }));
      target.dispatchEvent(
        new dom.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
        }) as unknown as Event
      );
    });
    expect(stagePage(container)).toBeUndefined();
    expect(layer()).not.toBe(before);
    // The guard lasts one task: the next click opens the card.
    await new Promise(resolve => setTimeout(resolve, 0));
    await act(async () => card(container, 'build').click());
    expect(stagePage(container)).toBe('build');
  } finally {
    await unmount();
  }
});

const settle = async (until: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 20 && !until(); turn++)
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
};

test('a failed refresh says so and keeps the map it last read', async () => {
  // The harness's fetch throws: every read the map makes here fails.
  const { container, unmount } = await mount();
  try {
    await act(async () => invalidate(K.factoryItems(ID)));
    await settle(() => container.querySelector('[role="status"]') !== null);
    const status = container.querySelector('[role="status"]')?.textContent;
    expect(status).toContain('Could not refresh: the test fetched');
    expect(status).toContain('Showing the last values read.');
    expect(card(container, 'landed').getAttribute('aria-label')).toBe('Merged: 1 here');
  } finally {
    await unmount();
  }
});

/** A server whose items read answers `items` only once `release` is called. */
function holdItemsRead(answer: FactoryItem[]): { release: () => void; restore: () => void } {
  const originalFetch = globalThis.fetch;
  let release = (): void => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (!isItemsRead(url)) return Response.json({ error: 'not in this test' }, { status: 404 });
      await gate;
      return itemsReadAnswer(answer)(url);
    },
    { preconnect: originalFetch.preconnect }
  );
  return {
    release,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test('before the items answer, every declared card and arrow is drawn with skeleton chips, never a count', async () => {
  const server = holdItemsRead(items);
  const { container, unmount } = await mount(null);
  try {
    const stages = shippedListed.declaration.map.cards.map(entry => entry.stage);
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-stage]')].map(el => el.dataset.stage)
    ).toEqual(stages);
    expect(container.querySelectorAll('g[data-arrow]')).toHaveLength(4);
    // A skeleton bar, never "…" (rule 6).
    expect(container.querySelector('[style*="scale("]')?.textContent).not.toContain('…');
    for (const stage of stages) {
      expect(
        container.querySelector(`[data-stage="${stage}"] [data-chip="loading"]`)
      ).not.toBeNull();
      expect(card(container, stage).getAttribute('aria-label')).toMatch(/: loading$/);
    }
    expect(card(container, 'landed').getAttribute('aria-label')).toBe('Merged: loading');
    expect(container.querySelector('[data-chip="here"]')).toBeNull();
    expect(container.textContent).not.toContain('0 here');
    // No page-level "Loading…": the cards carry it.
    expect(container.querySelector('[role="status"]')).toBeNull();

    // A details panel opened while loading says so, not that the stage is empty.
    await act(async () => details(container, 'plan-build').click());
    const panel = (): Element | null =>
      container.querySelector('aside[aria-label="Plan & build details"]');
    expect(panel()?.textContent).toContain('Items hereLoading the items here');
    expect(panel()?.querySelector('[data-skeleton="line"]')).not.toBeNull();
    expect(panel()?.textContent).not.toContain('Nothing here now.');
    // A shadow step's line says "…" too, never that it decided nothing.
    expect(shadowTitle(container, 'triage')).toContain('Would it start on its own · …');
    expect(shadowTitle(container, 'triage')).not.toContain('nothing decided yet');

    // The answer fills the chips in on the same cards, and the open panel stays open.
    server.release();
    await settle(() => container.querySelector('[data-chip="here"]') !== null);
    expect(card(container, 'landed').getAttribute('aria-label')).toBe('Merged: 1 here');
    expect(card(container, 'build').getAttribute('aria-label')).toBe(
      'Build: 2 here, 1 being worked, 1 needs you'
    );
    expect(container.querySelector('[data-chip="loading"]')).toBeNull();
    expect(panel()?.textContent).toContain('Items here · 2');
    // These items carry no shadow decision: now it is true that none was decided.
    expect(shadowTitle(container, 'triage')).toContain(
      'Would it start on its own · nothing decided yet'
    );
    expect(details(container, 'plan-build').getAttribute('aria-pressed')).toBe('true');
  } finally {
    server.restore();
    await unmount();
  }
});

test('a first items read that fails says so over the map drawn from the declaration, and no card claims to be loading', async () => {
  // The harness's fetch throws: every read the map makes here fails.
  const { container, unmount } = await mount(null);
  try {
    await settle(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('the test fetched');
    // Nothing retries a failed read: the cards and the panel must not claim it is loading.
    expect(card(container, 'landed').getAttribute('aria-label')).toBe(
      'Merged: items could not be read'
    );
    expect(container.querySelector('[data-chip]')).toBeNull();
    await act(async () => details(container, 'plan-build').click());
    const panel = container.querySelector('aside[aria-label="Plan & build details"]');
    expect(panel?.textContent).toContain('Could not be read.');
    expect(shadowTitle(container, 'triage')).toContain(
      'Would it start on its own · could not be read'
    );
  } finally {
    await unmount();
  }
});
