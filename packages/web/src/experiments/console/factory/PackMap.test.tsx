import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import type { PackGraph } from '../skills/items';
import type { PackBoardGroups } from './lib/board-numbers';
import { testGraph } from './curated.test-fixtures';
import { asksOn, itemOn, MOVING_ITEMS } from './items.test-fixtures';
import { installDom } from './test-dom.test-helpers';

const { mount: mountTree, settle, dom } = await installDom();
// Loaded after the window exists: react-dom reads it when it loads.
const { PackMap } = await import('./PackMap');

const PROJECT = 'cb-1';
const PACK = 'Wirasm.archon-software-factory';
/** The items the board's Merged column lists: those merged in its last days. */
const MERGED_RECENT = [itemOn('m1', 'landed', 'done'), itemOn('m2', null, 'done')];
/** One merged before those days: the Table lists it, the Merged column and the map do not. */
const MERGED_EARLIER = [itemOn('m3', 'landed', 'done')];

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  dom.happyDOM.settings.device.prefersReducedMotion = 'no-preference';
  for (const prefix of ['pack-graph', 'board']) invalidate(prefix);
});

/**
 * The pack's board as `packBoard` groups it: the moving items, two merged in the Merged column's
 * days and one before them. Its all-time merged count (3) differs from the recent one (2), so a
 * map counting the wrong one fails.
 */
const BOARD: PackBoardGroups = {
  moving: MOVING_ITEMS,
  unplaced: [],
  decide: [],
  merged: { recent: MERGED_RECENT, earlier: MERGED_EARLIER },
  onBoard: [...MOVING_ITEMS, ...MERGED_RECENT, ...MERGED_EARLIER],
  numbers: {
    inFlight: MOVING_ITEMS.length,
    mergedToday: 1,
    mergedRecent: MERGED_RECENT.length,
    merged: MERGED_RECENT.length + MERGED_EARLIER.length,
    total: MOVING_ITEMS.length + MERGED_RECENT.length + MERGED_EARLIER.length,
    medianToMergedMs: null,
  },
};

/** Open asks on the two items the map counts as needing you (b2 on build, g1 at the land gate). */
const ASKS = asksOn(MOVING_ITEMS.filter(read => ['b2', 'g1'].includes(read.item.key)));

/** Mounts the map with nothing but the pack graph read: no view file exists to read. */
async function mount(search = '', asks = ASKS, graph: PackGraph = testGraph): Promise<HTMLElement> {
  set(K.packGraph(PROJECT, PACK), graph);
  const mounted = await mountTree(
    <MemoryRouter initialEntries={[`/console/p/${PROJECT}/overview${search}`]}>
      <Routes>
        <Route
          path="/console/p/:projectId/overview"
          element={
            <PackMap
              projectId={PROJECT}
              pack={PACK}
              board={BOARD}
              itemsError={undefined}
              asks={asks}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
  await settle();
  unmount = mounted.unmount;
  return mounted.container;
}

/**
 * The test graph as the engine serves it when the pack's document leaves `stage-host` out of
 * every group: the stage heads a column alone, and the document lists why.
 */
const withoutStageHost: PackGraph = {
  ...testGraph,
  document:
    testGraph.document === null
      ? null
      : { ...testGraph.document, problems: ["stage 'stage-host' is in no group"] },
  groups: testGraph.groups.map(group => ({
    ...group,
    stages: group.stages.filter(stage => stage !== 'stage-host'),
  })),
};
/** The test graph with no document groups: nothing to group a map by. */
const ungrouped: PackGraph = { ...testGraph, groups: [] };

const cards = (page: ParentNode): string[] =>
  [...page.querySelectorAll('[data-card]')].map(card => card.getAttribute('data-card') ?? '');
const stageLinks = (page: ParentNode): string[] =>
  [...page.querySelectorAll('[data-stage]')].map(link => link.getAttribute('data-stage') ?? '');

describe('which map is drawn', () => {
  test('a pack whose document declares groups draws the grouped map from the graph alone', async () => {
    const page = await mount();
    expect(
      [...page.querySelectorAll('[aria-label="Which map"] button')].map(
        button => button.textContent
      )
    ).toEqual(['Map', 'Full workflow']);
    expect(cards(page)).toEqual(['intake', 'plan-and-build', 'checks', 'landing', 'landed']);
    // Each column's stages in flow order, columns by their first stage's place, Merged last.
    expect(stageLinks(page)).toEqual([
      'order',
      'triage',
      'link',
      'split',
      'survey',
      'plan',
      'stage-build',
      'stage-check',
      'stage-host',
      'landgate',
      'land',
      'discoveries',
      'close',
      'order-done',
      'landed',
    ]);
    expect(page.querySelector('div[data-flow]')).toBeNull();
  });

  test("its cards count the board's items and its Merged column", async () => {
    const page = await mount();
    const chip = (stage: string): string =>
      page.querySelector(`[data-stage="${stage}"]`)?.getAttribute('aria-label') ?? '';
    const numbers = (stage: string): string[] => chip(stage).match(/\d+/g) ?? [];
    // Build: 2 here, 1 of them worked, 1 needing you. Landed: the Board's Merged column, the
    // two merged in its days, not the three merged in all.
    expect(numbers('stage-build')).toEqual(['2', '1', '1']);
    expect(numbers('landed')).toEqual(['2']);
    // Every in-flow stage has a row, so discoveries' item is counted there, not listed apart.
    expect(numbers('discoveries')).toEqual(['1', '1']);
    expect(page.querySelector('[aria-label="Not on the map"]')).toBeNull();
  });

  test('a pack whose document declares no groups draws the derived map, with no map choice', async () => {
    const page = await mount('', ASKS, ungrouped);
    expect(page.querySelector('div[data-flow]')).not.toBeNull();
    expect(cards(page)).toEqual([]);
    expect(page.querySelector('[aria-label="Which map"]')).toBeNull();
  });

  test('a clean document shows no problem line', async () => {
    const page = await mount();
    expect(page.querySelector('[data-document-problems]')).toBeNull();
  });

  test('pressing Full workflow shows the derived map in place of the grouped one', async () => {
    const page = await mount();
    const full = [...page.querySelectorAll('[aria-label="Which map"] button')].find(
      button => button.textContent === 'Full workflow'
    );
    await click(full);
    expect(page.querySelector('div[data-flow]')).not.toBeNull();
    expect(cards(page)).toEqual([]);
  });

  test("the Full workflow heads an ungrouped stage's column by its label, a group's by its name (#261)", async () => {
    const page = await mount('?map=full', ASKS, withoutStageHost);
    const heading = (group: string): string | null | undefined =>
      page.querySelector(`[data-flow-group="${group}"] [data-flow-heading]`)?.textContent;
    expect(heading('stage-host')).toBe('CI and review');
    expect(heading('Plan and build')).toBe('Plan and build');
    expect(heading('merged')).toBe('Merged');
    // Its card names it once, by label: the eyebrow is its kind, never the workflow id.
    const card = page.querySelector('[data-flow-stage="stage-host"]')?.textContent ?? '';
    expect(card).toContain('CI and review');
    expect(card).not.toContain('stage-host');
    // No card on the map prints its own stage id.
    for (const node of page.querySelectorAll('[data-flow-stage]'))
      expect(node.textContent).not.toContain(node.getAttribute('data-flow-stage') ?? '');
  });

  test("the pack document's problems show above the map, and the groups left still draw", async () => {
    const page = await mount('', ASKS, withoutStageHost);
    const listed = page.querySelector('[data-document-problems]');
    expect(listed?.querySelector('summary')?.textContent).toContain('how-it-works.md');
    expect(listed?.querySelector('li')?.textContent).toBe("stage 'stage-host' is in no group");
    expect(cards(page)).toEqual([
      'intake',
      'plan-and-build',
      'checks',
      'stage-host',
      'landing',
      'landed',
    ]);
  });

  test("the Full workflow's Merged heading counts the Board's Merged column, not every merge", async () => {
    const page = await mount('?map=full');
    expect(page.querySelector('[data-flow-group="merged"] [data-count]')?.textContent).toBe('2');
  });
});

async function click(element: Element | null | undefined): Promise<void> {
  if (element == null) throw new Error('nothing to click');
  await act(async () => (element as HTMLElement).click());
  await settle();
}

/** The open stage modal, which renders into the body, not the mounted container. */
const dialog = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (found === null) throw new Error('no stage modal is open');
  return found;
};

async function openTab(label: string): Promise<void> {
  const tab = [...dialog().querySelectorAll('[role="tab"]')].find(
    button => button.textContent === label
  );
  if (tab === undefined) throw new Error(`no tab "${label}"`);
  await act(async () => (tab as HTMLElement).click());
}

const texts = (selector: string, attribute?: string): string[] =>
  [...dialog().querySelectorAll(selector)].map(node =>
    attribute === undefined ? (node.textContent ?? '') : (node.getAttribute(attribute) ?? '')
  );

describe('the stage modal', () => {
  test("clicking build on the map opens it: what it does from its display phases, the items standing on it, and its graph stage's steps", async () => {
    // The run records the board card reads for Build's items: b1's run works build__build now.
    const running = (id: string, steps: string[]) => ({
      id,
      status: 'running',
      completed_at: null,
      returns: { availability: 'unavailable' },
      node_outcomes: { run_id: id, first_failed_node: null, nodes: [] },
      loop_iterations: [],
      running: steps,
    });
    set(K.cardReads(PROJECT, ['run-b1', 'run-b2']), {
      records: [running('run-b1', ['build__build']), running('run-b2', [])],
      missing: [],
      unreadable: [],
    });
    const page = await mount();
    await click(page.querySelector('[data-stage="stage-build"]'));
    expect(dialog().querySelector('h3')?.textContent).toBe('Build');
    expect(texts('[data-drilldown-card]', 'data-drilldown-card')).toEqual([
      'Write or fix the change',
      'Count the round',
      'Hand off',
    ]);
    await openTab('Items here now');
    expect(texts('[data-item]', 'data-item')).toEqual(['b1', 'b2']);
    // b1's line is the board card's: its stage and the step its run works, in the pack's words.
    const b1 = dialog().querySelector('[data-item="b1"] [data-state]')?.textContent ?? '';
    expect(b1).toContain('Writes or fixes the change');
    await openTab('The real workflow');
    expect(texts('[data-workflow]', 'data-workflow')).toEqual(['stage-build']);
    expect(texts('[data-step]', 'data-step')).toEqual(
      testGraph.stages.find(stage => stage.workflow === 'stage-build')?.nodes.map(n => n.id) ?? []
    );
  });

  test("a stage's 'N need you' counts exactly its Items here now lines that say Needs you (#243)", async () => {
    // b1 runs with an open ask, b2 waits with one: both have a card's Needs you button.
    set(K.cardReads(PROJECT, ['run-b1', 'run-b2']), { records: [], missing: [], unreadable: [] });
    const page = await mount(
      '',
      asksOn(MOVING_ITEMS.filter(read => ['b1', 'b2'].includes(read.item.key)))
    );
    const stage = page.querySelector('[data-stage="stage-build"]');
    const chip = Number(stage?.getAttribute('aria-label')?.match(/(\d+) needs? you/)?.[1] ?? 0);
    await click(stage);
    await openTab('Items here now');
    const lines = dialog().querySelectorAll('[data-item] [data-state="needs-you"]').length;
    expect(chip).toBe(2);
    expect(lines).toBe(chip);
  });

  test("the landed stage lists and counts the board's Merged column", async () => {
    await mount('?stage=landed');
    await openTab('Items here now');
    expect(texts('[data-item]', 'data-item')).toEqual(['m1', 'm2']);
    const numbersIn = (selector: string): string[] =>
      dialog().querySelector(selector)?.textContent?.match(/\d+/g) ?? [];
    expect(numbersIn('[data-items-here] h6')).toEqual(['2']);
    expect(dialog().querySelector('[data-items-here]')?.textContent).not.toContain('landed');
  });
});

describe("the map's send-backs and flow", () => {
  const routes = (page: ParentNode): string[] =>
    [...page.querySelectorAll('[data-route]')].map(route => route.getAttribute('data-route') ?? '');
  const routePills = (page: ParentNode): string[] =>
    [...page.querySelectorAll('[data-route-pill] [data-pill]')].map(
      pill => pill.getAttribute('data-pill') ?? ''
    );
  const card = (page: ParentNode, id: string): Element => {
    const found = page.querySelector(`[data-card="${id}"]`);
    if (found === null) throw new Error(`no card ${id}`);
    return found;
  };
  /** React reads enter and leave from mouseover and mouseout. */
  const pointer = async (target: Element, kind: 'mouseover' | 'mouseout'): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(
        new dom.MouseEvent(kind, {
          bubbles: true,
          relatedTarget: dom.document.body,
        }) as unknown as Event
      );
    });
  };
  const click = async (target: Element): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event);
    });
  };

  // Checks' stages send back to plan and to build, both in Plan and build: one route, card to card.
  const CHECKS_ROUTES = ['checks>plan-and-build'];

  test('by default the map draws no send-back and no send-back pill', async () => {
    const page = await mount();
    expect(routes(page)).toEqual([]);
    expect(routePills(page)).toEqual([]);
  });

  test("each card's badge counts the routes leaving it, one per earlier card; none for a card's own retries", async () => {
    const page = await mount();
    const badges = Object.fromEntries(
      [...page.querySelectorAll('[data-send-back-badge]')].map(badge => [
        badge.getAttribute('data-send-back-badge'),
        badge.textContent,
      ])
    );
    // Intake and Plan and build only send work back inside themselves: no badge.
    expect(badges).toEqual({
      checks: '↺ 1',
      landing: '↺ 1',
      landed: '↺ 1',
    });
    for (const id of ['checks', 'landing', 'landed']) {
      await pointer(card(page, id), 'mouseover');
      expect(routes(page)).toHaveLength(1);
      await pointer(card(page, id), 'mouseout');
    }
  });

  test('hovering a card draws exactly its routes, each with its pill; leaving it hides them', async () => {
    const page = await mount();
    await pointer(card(page, 'checks'), 'mouseover');
    expect(routes(page)).toEqual(CHECKS_ROUTES);
    expect(routePills(page)).toEqual([
      'Back to Plan and build: Checks sent it back, one more round +2',
    ]);
    await pointer(card(page, 'checks'), 'mouseout');
    await pointer(card(page, 'landing'), 'mouseover');
    expect(routePills(page)).toEqual([
      'Back to Plan and build: Landing sent it back, behind its branch',
    ]);
    await pointer(card(page, 'landing'), 'mouseout');
    await pointer(card(page, 'landed'), 'mouseover');
    expect(routePills(page)).toEqual(['Back to Intake: broke the branch, fix ordered']);
    await pointer(card(page, 'landed'), 'mouseout');
    expect(routes(page)).toEqual([]);
  });

  test("focus on a card's link shows its routes", async () => {
    const page = await mount();
    const link = card(page, 'checks').querySelector('a');
    await act(async () => (link as unknown as HTMLElement | null)?.focus());
    expect(routes(page)).toEqual(CHECKS_ROUTES);
  });

  test('the badge pins them; a press that starts a pan keeps the pin, a click elsewhere drops it', async () => {
    const page = await mount();
    const badge = card(page, 'checks').querySelector('[data-send-back-badge]') as Element;
    await click(badge);
    expect(badge.getAttribute('aria-pressed')).toBe('true');
    expect(routes(page)).toEqual(CHECKS_ROUTES);
    // A press on the frame starts a pan; the pin holds.
    const frame = page.querySelector('.factory-canvas') as Element;
    await act(async () => {
      frame.dispatchEvent(
        new dom.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event
      );
    });
    expect(routes(page)).toEqual(CHECKS_ROUTES);
    // Only the pinned card's shortened pill ("one more round +2") gets a tip: no other route pill.
    const routeTips = [...page.querySelectorAll('[data-pill-tip]')].filter(button =>
      button.getAttribute('aria-label')?.includes(' back to ')
    );
    expect(routeTips.map(button => button.getAttribute('aria-label')?.split(':')[0])).toEqual([
      'Checks back to Plan and build',
    ]);
    const tip = routeTips[0];
    // A click on the tip keeps the pin.
    await click(tip as Element);
    expect(routes(page)).toEqual(CHECKS_ROUTES);
    await click(frame);
    expect(routes(page)).toEqual([]);
  });

  test('on touch, a second press on the badge hides the routes though the tap left the card hovered', async () => {
    const page = await mount();
    const badge = card(page, 'checks').querySelector('[data-send-back-badge]') as Element;
    // A tap sends an emulated mouseover before its click.
    await pointer(badge, 'mouseover');
    await click(badge);
    expect(routes(page)).toEqual(CHECKS_ROUTES);
    await pointer(badge, 'mouseover');
    await click(badge);
    expect(badge.getAttribute('aria-pressed')).toBe('false');
    expect(routes(page)).toEqual([]);
  });

  test('pressing a focused badge twice, as the keyboard does, hides the routes too', async () => {
    const page = await mount();
    const badge = card(page, 'checks').querySelector('[data-send-back-badge]') as HTMLElement;
    // Script focus is focus-visible in happy-dom, as Tab is in a browser.
    await act(async () => badge.focus());
    expect(routes(page)).toEqual(CHECKS_ROUTES);
    await click(badge);
    await click(badge);
    expect(routes(page)).toEqual([]);
  });

  test('Escape that closes the stage modal keeps the pin; with nothing else open it unpins', async () => {
    const page = await mount('?stage=stage-check');
    const badge = card(page, 'checks').querySelector('[data-send-back-badge]') as Element;
    await click(badge);
    expect(routes(page)).toEqual(CHECKS_ROUTES);
    const escape = async (): Promise<void> => {
      await act(async () => {
        window.dispatchEvent(
          new dom.KeyboardEvent('keydown', { key: 'Escape' }) as unknown as Event
        );
      });
      await settle();
    };
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await escape();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(routes(page)).toEqual(CHECKS_ROUTES);
    await escape();
    expect(routes(page)).toEqual([]);
  });

  test('the frame hugs the cards and grows under them while a card shows its send-backs', async () => {
    const page = await mount();
    const frame = page.querySelector('.factory-canvas') as HTMLElement;
    const hugged = Number.parseFloat(frame.style.height);
    await pointer(card(page, 'checks'), 'mouseover');
    expect(Number.parseFloat(frame.style.height)).toBeGreaterThan(hugged);
    await pointer(card(page, 'checks'), 'mouseout');
    expect(Number.parseFloat(frame.style.height)).toBe(hugged);
  });

  test('the Full workflow legend names no hover, badge or moving dot: that view has none', async () => {
    const full = await mount('?map=full');
    const lines = full.querySelector('[aria-label="Lines"]');
    expect(lines).not.toBeNull();
    const legend = lines?.textContent ?? '';
    expect(legend).not.toContain('↺');
    expect(legend).not.toContain('dot');
    await unmount?.();
    const grouped = await mount();
    expect(grouped.querySelector('[aria-label="Lines"]')?.textContent).toContain('↺');
  });

  test('with motion allowed, a dot follows the forward flow and one leaves along each shown route', async () => {
    const page = await mount();
    // The fixture has a run working on build: its running dot is drawn.
    expect(page.querySelector('.map-flow-dot')).not.toBeNull();
    expect(page.querySelectorAll('[data-map-flow] [data-map-flow-move]')).toHaveLength(
      page.querySelectorAll('[data-arrow]').length
    );
    await pointer(card(page, 'checks'), 'mouseover');
    expect(
      [...page.querySelectorAll('[data-branch-dot]')].map(dot =>
        dot.getAttribute('data-branch-dot')
      )
    ).toEqual(CHECKS_ROUTES);
  });

  test('under reduced motion no dot is drawn, even while a card shows its routes', async () => {
    dom.happyDOM.settings.device.prefersReducedMotion = 'reduce';
    const page = await mount();
    await pointer(card(page, 'checks'), 'mouseover');
    expect(routes(page)).toEqual(CHECKS_ROUTES);
    expect(page.querySelector('[data-map-flow]')).toBeNull();
    expect(page.querySelector('.map-flow-dot')).toBeNull();
    expect(page.querySelector('[data-branch-dot]')).toBeNull();
  });
});
