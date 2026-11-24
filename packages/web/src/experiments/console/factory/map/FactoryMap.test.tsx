import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from 'bun:test';
import { Window } from 'happy-dom';
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
import { FIT_PAD, MAP_SMALLEST_PX, READABLE_K } from '../lib/map-camera';
import { layoutMap } from '../lib/map-layout';
import type { FactoryViewListed } from '../lib/views';
import { cancelRereads } from '../merge-reread';
import { cancelMergeWatches } from '../merge-watch';
import { FactoryMap } from './FactoryMap';

// Opening a card's stage or its details needs clicks, which static markup cannot reach.
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

afterAll(async () => {
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
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  if (read !== null) set(K.factoryItems(ID), { items: read, members: {} });
  set(K.projectAttention(ID), queue);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
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
    )
  );
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
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

test('every card shows its chips and links to its stage; its details button lists the items there', async () => {
  const { container, unmount } = await mount();
  try {
    expect(card(container, 'build').getAttribute('aria-label')).toBe(
      'Build: 2 here, 1 being worked, 1 needs you'
    );
    expect(card(container, 'checks').getAttribute('aria-label')).toBe(
      'Checks: 1 here, 1 being worked'
    );
    expect(card(container, 'landed').getAttribute('aria-label')).toBe('Merged: 1 here');
    // What a person sees: the chips drawn on the card, by count.
    const chip = (stage: string, kind: string): string | null | undefined =>
      container.querySelector(`[data-stage="${stage}"] [data-chip="${kind}"]`)?.textContent;
    expect(chip('build', 'here')).toContain('2');
    expect(chip('build', 'need-you')).toContain('1');
    expect(chip('checks', 'here')).toContain('1');
    expect(chip('checks', 'need-you')).toBeUndefined();
    expect(chip('plan', 'here')).toBeUndefined();
    expect(card(container, 'build').getAttribute('href')).toBe(
      `/console/p/${ID}/factory?stage=build`
    );

    await act(async () => details(container, 'plan-build').click());
    const panel = container.querySelector('aside[aria-label="Plan & build details"]');
    // Each of the card's stages in turn: its workflows, and the items there.
    const links = [...(panel?.querySelectorAll('li a') ?? [])].map(link =>
      link.getAttribute('href')
    );
    expect(links).toEqual([
      `/console/p/${ID}/factory?stage=plan`,
      `/console/p/${ID}/factory/items/5`,
      `/console/p/${ID}/factory/items/9`,
      // Build's one workflow the pack runs now, stage-build, opens the stage; the retired
      // deliver still places Build's old items but is not offered as a workflow.
      `/console/p/${ID}/factory?stage=build`,
    ]);
    const chips = [...(panel?.querySelectorAll('li a.font-mono') ?? [])].map(
      link => link.textContent
    );
    expect(chips).toEqual(['plan', 'stage-build']);
    expect(panel?.textContent).toContain('Needs you');
    expect(panel?.textContent).toContain('Build · Writes the change');
  } finally {
    await unmount();
  }
});

test('the map draws one card per board column, a card of several stages a row for each', async () => {
  const { container, unmount } = await mount();
  try {
    const cards = [...container.querySelectorAll<HTMLElement>('[data-card]')];
    expect(cards.map(el => el.dataset.card)).toEqual([
      'intake',
      'plan-build',
      'checks-review',
      'ready',
      'merged',
    ]);
    const rows = (id: string): (string | null)[] =>
      [...container.querySelectorAll(`[data-card="${id}"] a[data-stage]`)].map(link =>
        link.getAttribute('href')
      );
    expect(rows('plan-build')).toEqual([
      `/console/p/${ID}/factory?stage=plan`,
      `/console/p/${ID}/factory?stage=build`,
    ]);
    expect(rows('merged')).toEqual([`/console/p/${ID}/factory?stage=landed`]);
    // A card of one stage reads its short line, not its blurb; a row of a card of several, its own.
    const ready = container.querySelector('[data-card="ready"]')?.textContent ?? '';
    expect(ready).toContain('Gated, merged on land');
    expect(ready).not.toContain('A gate reads the approved change');
    const planBuild = container.querySelector('[data-card="plan-build"]')?.textContent ?? '';
    expect(planBuild).toContain('Plans how to build it');
    expect(planBuild).not.toContain('Works out how to build the item');
    // Build's row shows who needs you there in place of its short line.
    expect(planBuild).not.toContain('Writes the change and PR');
    expect(container.textContent).not.toContain('Landed');
  } finally {
    await unmount();
  }
});

test('a card is lit while it holds an item, the merged card never; the canvas carries its texture', async () => {
  const { container, unmount } = await mount();
  try {
    const boxes = [...container.querySelectorAll<HTMLElement>('[data-card] > .factory-card')];
    // Every card is drawn in the card identity, each tinted in its group's colour.
    expect(boxes.length).toBe(5);
    for (const box of boxes) expect(box.style.getPropertyValue('--card-tone')).toMatch(/^var\(--/);
    const lit = [...container.querySelectorAll<HTMLElement>('.factory-card[data-lit]')].map(
      box => box.parentElement?.dataset.card
    );
    // Build and Checks hold items; Intake and Ready to merge hold none; Merged holds one for good.
    expect(lit).toEqual(['plan-build', 'checks-review']);
    expect(container.querySelector('[role="group"]')?.className).toContain('factory-canvas');
    // The selected card is marked for its accent ring, and only it.
    await act(async () => details(container, 'ready').click());
    const selected = [...container.querySelectorAll<HTMLElement>('.factory-card[data-selected]')];
    expect(selected.map(box => box.parentElement?.dataset.card)).toEqual(['ready']);
  } finally {
    await unmount();
  }
});

test('a dot runs into a card a run works an item on, along the hand-off into it, and not under reduced motion', async () => {
  const { container, unmount } = await mount();
  try {
    const dots = [...container.querySelectorAll<HTMLElement>('[data-flow]')];
    // Build and Checks each have an item a run works; nothing runs in the others.
    expect(dots.map(el => el.dataset.flow)).toEqual(['plan-build', 'checks-review']);
    for (const dot of dots) {
      expect(dot.className).toContain('map-flow-dot');
      expect(dot.className).toContain('motion-reduce:hidden');
    }
  } finally {
    await unmount();
  }
  // The first card has no hand-off into it, so no dot, though a run works an item there.
  const first = await mount([itemWith('t', [run('triage', 'running')])]);
  try {
    expect(hereChip(first.container, 'triage')).toContain('1');
    expect(first.container.querySelector('[data-flow]')).toBeNull();
  } finally {
    await first.unmount();
  }
});

test('no text the camera scales is under the type floor the readable scale assumes', async () => {
  const { container, unmount } = await mount();
  try {
    const layer = container.querySelector('[style*="scale("]');
    if (layer === null) throw new Error('The map layer was not rendered');
    const sizes = [...layer.querySelectorAll('[class*="text-console-"]')].flatMap(el =>
      [...el.getAttribute('class')!.matchAll(/text-console-(\d+)/g)].map(m => Number(m[1]))
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(MAP_SMALLEST_PX);
  } finally {
    await unmount();
  }
});

test('a click on a card opens its stage over the map', async () => {
  const { container, unmount } = await mount();
  try {
    await act(async () => card(container, 'checks').click());
    expect(stagePage(container)).toBe('checks');
  } finally {
    await unmount();
  }
});

test('the details button opens and closes the panel and never leaves the map', async () => {
  const { container, unmount } = await mount();
  try {
    await act(async () => details(container, 'merged').click());
    expect(container.querySelector('aside[aria-label="Merged details"]')).not.toBeNull();
    expect(details(container, 'merged').getAttribute('aria-pressed')).toBe('true');
    expect(stagePage(container)).toBeUndefined();
    await act(async () => details(container, 'merged').click());
    expect(container.querySelector('aside')).toBeNull();
    expect(stagePage(container)).toBeUndefined();
  } finally {
    await unmount();
  }
});

test('a drag that ends on a card pans the map and does not open the card', async () => {
  const { container, unmount } = await mount();
  try {
    const target = card(container, 'build');
    const layer = (): string | null | undefined =>
      container.querySelector<HTMLElement>('[style*="scale("]')?.style.transform;
    const before = layer();
    const send = (event: Event): void => {
      target.dispatchEvent(event);
    };
    const pointer = (type: string, init: Record<string, number>): Event =>
      new dom.PointerEvent(type, { bubbles: true, cancelable: true, ...init }) as unknown as Event;
    await act(async () => {
      send(
        pointer('pointerdown', { button: 0, buttons: 1, pointerId: 1, clientX: 100, clientY: 100 })
      );
      send(pointer('pointermove', { buttons: 1, pointerId: 1, clientX: 140, clientY: 100 }));
      send(pointer('pointerup', { pointerId: 1, clientX: 140, clientY: 100 }));
      send(
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

/** Item 4, whose deliver run is in its checks, with its running step set to `step`. */
function checking(step: string | null): FactoryItem {
  const item = realItem('4');
  const progress = item.progress;
  if (progress === null || progress.running === null) throw new Error('item 4 is running');
  return { ...item, progress: { ...progress, running: { ...progress.running, step } } };
}

/** The "N here" chip a card draws; null when it draws none (nothing there). */
const hereChip = (container: HTMLElement, stage: string): string | null =>
  container.querySelector(`[data-stage="${stage}"] [data-chip="here"]`)?.textContent ?? null;

test('a later read on a step no stage names keeps the card where the last read put it, as the board does', async () => {
  const { container, unmount } = await mount([checking('rounds.tests__tests')]);
  try {
    expect(hereChip(container, 'checks')).toContain('1');
    // Between rounds the run records only the bare loop group, which no stage names.
    await act(async () => set(K.factoryItems(ID), { items: [checking('rounds')], members: {} }));
    expect(hereChip(container, 'checks')).toContain('1');
    expect(hereChip(container, 'build')).toBeNull();
  } finally {
    await unmount();
  }
});

test('the map draws hand-offs between neighbouring cards, labelled on pills, and send-backs in one dashed lane', async () => {
  const { container, unmount } = await mount();
  try {
    const forward = [...container.querySelectorAll('g[data-arrow]')].map(g => g.textContent);
    // "build, narrow" stacks one outcome per line in one pill.
    // "fixed for CI" (build to CI and review) joins "built": the cards are neighbours.
    // A drop or reshape from Build skips Checks & review, so it names its target on that pill.
    // Three outcomes are past the pill's two lines: it reads the first and how many more.
    expect(forward).toEqual(['build,narrow', 'built +2', 'ready,drop or reshape', 'merged']);
    // Each is a declared arrow.
    const declared = shippedListed.declaration.map.arrows.map((_, i) => `decl:${i.toString()}`);
    for (const g of container.querySelectorAll('g[data-arrow]'))
      expect(declared).toContain(g.getAttribute('data-arrow') ?? '');
    // A forward line is 2 px, painted with its own gradient along the flow.
    for (const path of container.querySelectorAll('g[data-arrow] > path')) {
      expect(path.getAttribute('stroke-width')).toBe('2');
      const id = /^url\(#(.+)\)$/.exec(path.getAttribute('stroke') ?? '')?.[1] ?? '';
      expect(container.querySelector(`linearGradient[id="${id}"]`)).not.toBeNull();
    }
    const lane = [...container.querySelectorAll('path[data-lane="feedback"]')];
    expect(lane.length).toBeGreaterThan(0);
    for (const path of lane) {
      expect(path.getAttribute('stroke-dasharray')).toBe('6 4');
      expect(path.getAttribute('stroke')).toBe('var(--node-approval)');
    }
    const pills = [...container.querySelectorAll('g[data-lane-pill]')].map(
      g => `${g.getAttribute('data-lane-pill') ?? ''}: ${g.textContent ?? ''}`
    );
    expect(pills).toEqual([
      'order: pieces, broke the branch',
      'triage: split',
      'plan: replan, answers',
      'build: returned, sent back, answers',
      'ready: land, drop or reshape',
    ]);
    // The legend draws the send-back line as the map does.
    expect(
      container.querySelector('[data-legend="send-back"]')?.getAttribute('stroke-dasharray')
    ).toBe('6 4');
  } finally {
    await unmount();
  }
});

test('a pill past two lines lists its outcomes on hover, focus and tap, and Escape shuts the list', async () => {
  const { container, unmount } = await mount();
  try {
    const tips = [...container.querySelectorAll<HTMLButtonElement>('[data-pill-tip]')];
    // Only the pill that hides outcomes has one: "build, narrow" and "ready, drop or reshape" show all theirs.
    expect(tips).toHaveLength(1);
    const [tip] = tips as [HTMLButtonElement];
    const declared = layoutMap(shippedListed.declaration).arrows.find(
      arrow => arrow.from === 'plan-build'
    );
    expect(tip.getAttribute('data-pill-tip')).toBe(declared?.id ?? '');
    const outcomes = ['built', 'fixed for CI', 'drop or reshape → Ready to merge'];
    expect(tip.getAttribute('aria-label')).toBe(
      `Plan & build to Checks & review: ${outcomes.join(', ')}`
    );
    const listed = (): string[] | undefined => {
      const shown = container.querySelector('[role="tooltip"]');
      return shown === null ? undefined : [...shown.children].map(line => line.textContent ?? '');
    };
    expect(listed()).toBeUndefined();
    await act(async () => tip.focus());
    expect(listed()).toEqual(outcomes);
    expect(tip.getAttribute('aria-expanded')).toBe('true');
    await act(async () =>
      tip.dispatchEvent(
        new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event
      )
    );
    expect(listed()).toBeUndefined();
    await act(async () => tip.blur());
    // A tap: a touch browser focuses no button, so the click alone opens it.
    await act(async () => tip.click());
    expect(listed()).toEqual(outcomes);
    // A press on the pill keeps it open; one anywhere else shuts it, as the next tap does.
    const press = (target: Element): Promise<void> =>
      act(async () => {
        target.dispatchEvent(
          new dom.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event
        );
      });
    await press(tip);
    expect(listed()).toEqual(outcomes);
    await press(container);
    expect(listed()).toBeUndefined();
    await act(async () => tip.click());
    expect(listed()).toEqual(outcomes);
    await act(async () =>
      tip.dispatchEvent(
        new dom.MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: dom.document.body,
        }) as unknown as Event
      )
    );
    expect(listed()).toBeUndefined();
    await act(async () =>
      tip.dispatchEvent(
        new dom.MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: dom.document.body,
        }) as unknown as Event
      )
    );
    expect(listed()).toEqual(outcomes);
  } finally {
    await unmount();
  }
});

/** What `look` reads off the map over `read` when every element measures `width` wide. */
async function atWidth<T>(
  width: number,
  look: (container: HTMLElement) => T,
  read: FactoryItem[] = items
): Promise<T> {
  const proto = dom.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => width });
  const { container, unmount } = await mount(read);
  try {
    return look(container);
  } finally {
    await unmount();
    if (original) Object.defineProperty(proto, 'clientWidth', original);
    else Reflect.deleteProperty(proto, 'clientWidth');
  }
}

/** The distinct tops of the cards when every element measures `width` wide. */
const cardTopsAt = (width: number): Promise<Set<string>> =>
  atWidth(
    width,
    container =>
      new Set([...container.querySelectorAll<HTMLElement>('[data-card]')].map(el => el.style.top))
  );

/** The world layer's camera: its translate x and scale. */
function cameraOf(container: HTMLElement): { x: number; k: number } {
  const transform = container.querySelector<HTMLElement>('[style*="scale("]')?.style.transform;
  const match = /translate\((-?[\d.]+)px, -?[\d.]+px\) scale\(([\d.]+)\)/.exec(transform ?? '');
  if (match === null) throw new Error(`No camera in ${transform ?? 'nothing'}`);
  return { x: Number(match[1]), k: Number(match[2]) };
}

/** Where the left edge of a card lands in a frame, for camera `x` at scale 1. */
function leftIn(id: string, x: number): number {
  const box = layoutMap(shippedListed.declaration).cards.find(card => card.id === id)?.box;
  if (box === undefined) throw new Error(`No card ${id}`);
  return box.x + x;
}

test('on a phone the live map pans at the readable scale, opening at the start of the row', async () => {
  // Plan & build holds the most items in flight; the map still opens on Intake, whole.
  const camera = await atWidth(390, cameraOf);
  expect(camera.k).toBe(READABLE_K);
  expect(leftIn('intake', camera.x)).toBe(FIT_PAD);
});

test('a stage with no short line shows its blurb, on a card of its own and in a row', async () => {
  const declaration = shippedListed.declaration;
  const listed: FactoryViewListed = {
    ...shippedListed,
    declaration: {
      ...declaration,
      stages: declaration.stages.map(stage =>
        stage.id === 'ready' || stage.id === 'triage' ? { ...stage, short: undefined } : stage
      ),
    },
  };
  const { container, unmount } = await mount(items, listed);
  try {
    expect(container.querySelector('[data-card="ready"]')?.textContent).toContain(
      'A gate reads the approved change'
    );
    expect(container.querySelector('a[data-stage="triage"]')?.textContent).toContain(
      'Reads a new item and decides'
    );
  } finally {
    await unmount();
  }
});

test("the cards take one row at every width, a phone's included", async () => {
  for (const width of [358, 1100, 1600]) expect((await cardTopsAt(width)).size).toBe(1);
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

test('a failed refresh says so and keeps the map it last read', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => {
      throw new Error('the server is down');
    },
    { preconnect: originalFetch.preconnect }
  );
  const { container, unmount } = await mount();
  try {
    await act(async () => invalidate(K.factoryItems(ID)));
    for (let turn = 0; turn < 5 && container.querySelector('[role="status"]') === null; turn++)
      await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Could not refresh: the server is down. Showing the last values read.'
    );
    expect(card(container, 'landed').getAttribute('aria-label')).toBe('Merged: 1 here');
  } finally {
    globalThis.fetch = originalFetch;
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

const settle = async (until: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 20 && !until(); turn++)
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
};

test('before the items answer, every declared card and arrow is drawn with skeleton chips, never a count', async () => {
  const server = holdItemsRead(items);
  const { container, unmount } = await mount(null);
  try {
    const stages = shippedListed.declaration.map.cards.map(entry => entry.stage);
    const drawn = [...container.querySelectorAll<HTMLElement>('[data-stage]')];
    expect(drawn.map(el => el.dataset.stage)).toEqual(stages);
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
    const after = [...container.querySelectorAll<HTMLElement>('[data-stage]')];
    expect(after).toHaveLength(drawn.length);
    after.forEach((el, index) => expect(el).toBe(drawn[index]!));
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => {
      throw new Error('the server is down');
    },
    { preconnect: originalFetch.preconnect }
  );
  const { container, unmount } = await mount(null);
  try {
    await settle(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('the server is down');
    // Nothing retries a failed read: the cards and the panel must not claim it is loading.
    expect(card(container, 'landed').getAttribute('aria-label')).toBe(
      'Merged: items could not be read'
    );
    expect(container.querySelectorAll('[data-stage]')).toHaveLength(
      shippedListed.declaration.map.cards.length
    );
    expect(container.querySelector('[data-chip]')).toBeNull();
    await act(async () => details(container, 'plan-build').click());
    const panel = container.querySelector('aside[aria-label="Plan & build details"]');
    expect(panel?.textContent).toContain('Could not be read.');
    expect(panel?.textContent).not.toContain('Loading');
    expect(panel?.textContent).not.toContain('Nothing here now.');
    expect(shadowTitle(container, 'triage')).toContain(
      'Would it start on its own · could not be read'
    );
    await act(async () => details(container, 'intake').click());
    const intake = container.querySelector('aside[aria-label="Intake details"]');
    expect(intake?.textContent).toContain('Would it start on its own · could not be read');
    expect(intake?.textContent).not.toContain('nothing decided yet');
  } finally {
    globalThis.fetch = originalFetch;
    await unmount();
  }
});
