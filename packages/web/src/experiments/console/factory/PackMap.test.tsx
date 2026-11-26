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
const PATH = '/packs/Wirasm/archon-software-factory/af6d0b4a/.shared/factory-view.json';

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
/** A file the server read with two problems it worked around: the map still draws from it. */
const DRIFTED: PackView = {
  path: PATH,
  view: shippedFile,
  problems: [
    {
      kind: 'dropped',
      path: ['stages', 'stage-check'],
      message: 'names stage "stage-check", which pack "p" does not have',
    },
    {
      kind: 'unworded',
      path: ['stages', 'stage-review'],
      message: 'stage "stage-review" has no words',
    },
  ],
};
/** A file that does not read at all. */
const UNREADABLE: PackView = {
  path: PATH,
  view: null,
  problems: [{ kind: 'unreadable', path: [], message: 'is not JSON: oops' }],
};

const cards = (page: ParentNode): string[] =>
  [...page.querySelectorAll('[data-card]')].map(card => card.getAttribute('data-card') ?? '');
const stageLinks = (page: ParentNode): string[] =>
  [...page.querySelectorAll('[data-stage]')].map(link => link.getAttribute('data-stage') ?? '');

describe('the one check where the map is drawn', () => {
  test('a pack shipping a clean view file draws the curated map, not the derived one', async () => {
    const page = await mount(CURATED);
    expect(cards(page)).toEqual(['intake', 'plan-and-build', 'checks', 'landing', 'landed']);
    expect(stageLinks(page)).toEqual([
      'order',
      'triage',
      'link',
      'split',
      'complexity',
      'plan',
      'attend',
      'stage-build',
      'stage-check',
      'stage-host',
      'catchup',
      'landgate',
      'land',
      'discoveries',
      'close',
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
    expect(numbers('stage-build')).toEqual(['2', '1', '1']);
    expect(numbers('landed')).toEqual(['2']);
    // Every in-flow stage has a row, so discoveries' item is counted there, not listed apart.
    expect(numbers('discoveries')).toEqual(['1', '1']);
    expect(page.querySelector('[aria-label="Not on the map"]')).toBeNull();
  });

  test('a pack shipping no file draws the derived map and no card', async () => {
    const page = await mount(NO_FILE);
    expect(page.querySelector('div[data-flow]')).not.toBeNull();
    expect(cards(page)).toEqual([]);
    expect(page.querySelector('[data-map-note]')).toBeNull();
  });

  test('a file with problems still draws the curated map, and one line opens to every problem', async () => {
    const page = await mount(DRIFTED);
    expect(cards(page)).toEqual(['intake', 'plan-and-build', 'checks', 'landing', 'landed']);
    const line = page.querySelector('[data-view-problems]');
    expect(line?.querySelector('summary')).not.toBeNull();
    expect(
      [...(line?.querySelectorAll('li') ?? [])].map(entry =>
        entry.getAttribute('data-view-problem')
      )
    ).toEqual(['dropped', 'unworded']);
  });

  test('a clean file shows no problem line', async () => {
    const page = await mount(CURATED);
    expect(page.querySelector('[data-view-problems]')).toBeNull();
  });

  test('a file that does not read draws the derived map, says so, and lists why', async () => {
    const page = await mount(UNREADABLE);
    expect(page.querySelector('div[data-flow]')).not.toBeNull();
    expect(cards(page)).toEqual([]);
    expect(page.querySelector('[data-map-note]')).not.toBeNull();
    const line = page.querySelector('[data-view-problems]');
    expect(
      [...(line?.querySelectorAll('li') ?? [])].map(entry =>
        entry.getAttribute('data-view-problem')
      )
    ).toEqual(['unreadable']);
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
    await click(page.querySelector('[data-stage="stage-build"]'));
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
