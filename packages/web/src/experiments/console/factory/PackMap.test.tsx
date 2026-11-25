import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import type { PackView } from './api';
import type { PackBoardGroups } from './lib/board-numbers';
import { shippedFile, shippedGraph } from './curated.test-fixtures';
import { itemOn, MOVING_ITEMS } from './items.test-fixtures';
import { installDom } from './test-dom.test-helpers';

const { mount: mountTree, settle } = await installDom();
// Loaded after the window exists: react-dom reads it when it loads.
const { PackMap } = await import('./PackMap');

const PROJECT = 'cb-1';
const PACK = 'Wirasm.archon-software-factory';
/** The items the board's Merged column lists: those merged in its last days. */
const MERGED_RECENT = [itemOn('m1', 'landed', 'done'), itemOn('m2', null, 'done')];
/** One merged before those days: the Table lists it, the Merged column and the map do not. */
const MERGED_EARLIER = [itemOn('m3', 'landed', 'done')];
const PATH = '/packs/Wirasm/archon-software-factory/b62ec7b/.shared/factory-view.json';

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  for (const prefix of ['pack-view', 'pack-graph', 'board']) invalidate(prefix);
});

/**
 * The pack's board as `packBoard` groups it: the moving items, two merged in the Merged column's
 * days and one before them. Its all-time merged count (3) differs from the recent one (2), so a
 * map counting the wrong one fails.
 */
const BOARD: PackBoardGroups = {
  moving: MOVING_ITEMS,
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

async function mount(view: PackView, search = ''): Promise<HTMLElement> {
  set(K.packView(PROJECT, PACK), view);
  set(K.packGraph(PROJECT, PACK), shippedGraph);
  const mounted = await mountTree(
    <MemoryRouter initialEntries={[`/console/p/${PROJECT}/overview${search}`]}>
      <Routes>
        <Route
          path="/console/p/:projectId/overview"
          element={<PackMap projectId={PROJECT} pack={PACK} board={BOARD} itemsError={undefined} />}
        />
      </Routes>
    </MemoryRouter>
  );
  await settle();
  unmount = mounted.unmount;
  return mounted.container;
}

const CURATED: PackView = { path: PATH, view: shippedFile, problems: [] };
const NO_FILE: PackView = { path: null, view: null, problems: [] };
const BROKEN: PackView = {
  path: PATH,
  view: shippedFile,
  problems: [
    { severity: 'error', path: ['stages'], message: 'names step "limit", which it does not have' },
  ],
};

const cards = (page: ParentNode): string[] =>
  [...page.querySelectorAll('[data-card]')].map(card => card.getAttribute('data-card') ?? '');
const stageLinks = (page: ParentNode): string[] =>
  [...page.querySelectorAll('[data-stage]')].map(link => link.getAttribute('data-stage') ?? '');

describe('the one check where the map is drawn', () => {
  test('a pack shipping a clean view file draws the curated map, not the derived one', async () => {
    const page = await mount(CURATED);
    expect(cards(page)).toEqual(['intake', 'plan-and-build', 'checks', 'ready', 'landed']);
    expect(stageLinks(page)).toEqual([
      'order',
      'triage',
      'link',
      'plan',
      'build',
      'checks',
      'host',
      'ready',
      'landed',
    ]);
    expect(page.querySelector('div[data-flow]')).toBeNull();
  });

  test("its cards count the board's items and its Merged column", async () => {
    const page = await mount(CURATED);
    const chip = (stage: string): string =>
      page.querySelector(`[data-stage="${stage}"]`)?.getAttribute('aria-label') ?? '';
    const numbers = (stage: string): string[] => chip(stage).match(/\d+/g) ?? [];
    // Build: 2 here, 1 of them worked, 1 needing you. Landed: the Board's Merged column, the
    // two merged in its days, not the three merged in all.
    expect(numbers('build')).toEqual(['2', '1', '1']);
    expect(numbers('landed')).toEqual(['2']);
    expect(page.querySelector('[aria-label="Not on the map"]')?.textContent).toContain('d1');
  });

  test('a pack shipping no file draws the derived map and no card', async () => {
    const page = await mount(NO_FILE);
    expect(page.querySelector('div[data-flow]')).not.toBeNull();
    expect(cards(page)).toEqual([]);
    expect(page.querySelector('[data-map-note]')).toBeNull();
  });

  test('a file with an error against the graph draws the derived map and says why', async () => {
    const page = await mount(BROKEN);
    expect(page.querySelector('div[data-flow]')).not.toBeNull();
    expect(cards(page)).toEqual([]);
    expect(page.querySelector('[data-map-note]')?.textContent).toContain(
      'names step "limit", which it does not have'
    );
  });

  test('pressing Full workflow shows the derived map in place of the curated one', async () => {
    const page = await mount(CURATED);
    const full = [...page.querySelectorAll('[aria-label="Which map"] button')].find(
      button => button.textContent === 'Full workflow'
    );
    await click(full);
    expect(page.querySelector('div[data-flow]')).not.toBeNull();
    expect(cards(page)).toEqual([]);
  });

  test("the Full workflow's Merged heading counts the Board's Merged column, not every merge", async () => {
    const page = await mount(CURATED, '?map=full');
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
  test("clicking build on the map opens it: what it does from the file, the items standing on it, and its graph stage's steps", async () => {
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
    const page = await mount(CURATED);
    await click(page.querySelector('[data-stage="build"]'));
    expect(dialog().querySelector('h3')?.textContent).toBe('Build');
    expect(texts('[data-drilldown-card]', 'data-drilldown-card')).toEqual([
      'Write or fix the change',
      'Count the round',
      'Hand off',
    ]);
    await openTab('Items here now');
    expect(texts('[data-item]', 'data-item')).toEqual(['b1', 'b2']);
    // b1's line is the board card's: its stage and the step its run works, in the file's words.
    const b1 = dialog().querySelector('[data-item="b1"] [data-state]')?.textContent ?? '';
    expect(b1).toContain(shippedFile.stages['stage-build']?.steps?.build__build ?? 'missing');
    await openTab('The real workflow');
    expect(texts('[data-workflow]', 'data-workflow')).toEqual(['stage-build']);
    expect(texts('[data-step]', 'data-step')).toEqual(
      shippedGraph.stages.find(stage => stage.workflow === 'stage-build')?.nodes.map(n => n.id) ??
        []
    );
  });

  test('ready, a card of three stages: their phases, items and steps, each stage in turn', async () => {
    await mount(CURATED, '?stage=ready');
    expect(dialog().querySelector('h3')?.textContent).toBe('Ready to merge');
    expect(texts('[data-phase] h4')).toEqual(['1Gate', '2Merge', '3Drop or reshape']);
    await openTab('Items here now');
    expect(texts('[data-item]', 'data-item')).toEqual(['g1']);
    await openTab('The real workflow');
    expect(texts('[data-workflow]', 'data-workflow')).toEqual(['landgate', 'land', 'close']);
    const steps = ['landgate', 'land', 'close'].flatMap(
      workflow =>
        shippedGraph.stages.find(stage => stage.workflow === workflow)?.nodes.map(n => n.id) ?? []
    );
    expect(texts('[data-step]', 'data-step')).toEqual(steps);
  });

  test("the landed stage lists and counts the board's Merged column", async () => {
    await mount(CURATED, '?stage=landed');
    await openTab('Items here now');
    expect(texts('[data-item]', 'data-item')).toEqual(['m1', 'm2']);
    const numbersIn = (selector: string): string[] =>
      dialog().querySelector(selector)?.textContent?.match(/\d+/g) ?? [];
    expect(numbersIn('[data-items-here] h6')).toEqual(['2']);
    expect(dialog().querySelector('[data-items-here]')?.textContent).not.toContain('landed');
  });
});
