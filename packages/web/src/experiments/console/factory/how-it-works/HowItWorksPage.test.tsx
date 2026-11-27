import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Project } from '../../primitives/project';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import type { PackView } from '../api';
import { testFile, testGraph } from '../curated.test-fixtures';
import { installDom } from '../test-dom.test-helpers';

const { mount: mountTree, settle } = await installDom();
// Loaded after the window exists: react-dom reads it when it loads.
const { FactoryHome, HowItWorksPage } = await import('./HowItWorksPage');

const PACK = 'Wirasm.archon-software-factory';
const PATH = '/packs/Wirasm/archon-software-factory/dd30226/.shared/factory-view.json';

const project = (id: string, itemPacks: string[]): Project => ({
  id,
  name: id,
  path: `/work/${id}`,
  defaultBranch: 'main',
  repositoryUrl: null,
  lastSyncedAt: null,
  kind: 'repo',
  itemPacks,
});

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  for (const prefix of ['projects', 'pack-view', 'pack-graph']) invalidate(prefix);
});

/** Mounts the sidebar's Factory routes at `at`, the pack staged by the second project. */
async function mount(at: string, view: PackView, graph = testGraph): Promise<HTMLElement> {
  set(K.projects, [project('cb-0', []), project('cb-1', [PACK])]);
  set(K.packView('cb-1', PACK), view);
  set(K.packGraph('cb-1', PACK), graph);
  const mounted = await mountTree(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/console/factory" element={<FactoryHome />} />
        <Route path="/console/factory/:pack/how-it-works" element={<HowItWorksPage />} />
      </Routes>
    </MemoryRouter>
  );
  await settle();
  unmount = mounted.unmount;
  return mounted.container;
}

const CURATED: PackView = { path: PATH, view: testFile, problems: [] };
const NO_FILE: PackView = { path: null, view: null, problems: [] };
const page = `/console/factory/${PACK}/how-it-works`;

const cards = (within: ParentNode): string[] =>
  [...within.querySelectorAll('[data-card]')].map(card => card.getAttribute('data-card') ?? '');

/**
 * How it works is the pack's page and names no project (DESIGN.md, owner change 1 of
 * 2026-11-23): its derived flow shows no project's counts and opens no project's board.
 */
function namesNoProject(within: ParentNode): void {
  const flow = within.querySelector('div[data-flow]');
  expect(flow?.querySelector('[data-count], [data-need-you]')).toBeNull();
  expect(flow?.querySelector('a')).toBeNull();
  expect(within.querySelector('a[href*="/console/p/"]')).toBeNull();
}

describe('How it works', () => {
  test("/console/factory opens the first staged pack's How it works", async () => {
    const opened = await mount('/console/factory', CURATED);
    expect(opened.querySelector('[data-card]')).not.toBeNull();
  });

  test('the header names the pack as a person reads it, with the raw key on hover, file or not', async () => {
    for (const view of [CURATED, NO_FILE]) {
      const opened = await mount(page, view);
      const title = opened.querySelector('h1');
      expect(title?.textContent).toBe('Archon software factory');
      expect(title?.getAttribute('title')).toBe(PACK);
      await unmount?.();
      unmount = undefined;
    }
  });

  test("with the file: the root view's cards and its caption, from the file", async () => {
    const opened = await mount(page, CURATED);
    const { howItWorks } = testFile;
    expect(cards(opened)).toEqual(
      howItWorks.views[howItWorks.root]?.cards.map(card => card.id) ?? []
    );
    expect(opened.textContent).toContain(howItWorks.caption);
    expect(opened.querySelector('div[data-flow]')).toBeNull();
  });

  test('a file with problems still draws its picture, under one line that opens to the list', async () => {
    const problem = {
      kind: 'dropped' as const,
      path: ['howItWorks', 'views', 'factory', 'cards', 7, 'stages', 0],
      message: 'names stage "stage-check", which pack "p" does not have',
    };
    const opened = await mount(page, { ...CURATED, problems: [problem] });
    expect(opened.querySelector('[data-card]')).not.toBeNull();
    const line = opened.querySelector('[data-view-problems]');
    expect(line?.querySelector('summary')).not.toBeNull();
    expect(
      [...(line?.querySelectorAll('li') ?? [])].map(entry =>
        entry.getAttribute('data-view-problem')
      )
    ).toEqual(['dropped']);
    await unmount?.();
    unmount = undefined;
    expect((await mount(page, CURATED)).querySelector('[data-view-problems]')).toBeNull();
  });

  test('?view=build opens the build drill-down', async () => {
    const opened = await mount(`${page}?view=build`, CURATED);
    expect(cards(opened)).toEqual(
      testFile.howItWorks.views.build?.cards.map(card => card.id) ?? []
    );
  });

  test("without the file: the pack's document and the derived map", async () => {
    // The pack's main declares no document; one that does has it served with its graph.
    const document = { path: 'how-it-works.md', problems: [], text: '# How the factory works' };
    const opened = await mount(page, NO_FILE, { ...testGraph, document });
    expect(opened.querySelector('[data-document]')?.textContent).toContain('How the factory works');
    expect(opened.querySelector('div[data-flow]')).not.toBeNull();
    expect(cards(opened)).toEqual([]);
    namesNoProject(opened);
  });

  test('Full workflow draws the derived structure, naming no project', async () => {
    const opened = await mount(page, CURATED);
    const full = [...opened.querySelectorAll('[aria-label="Which map"] button')].find(
      button => button.textContent === 'Full workflow'
    );
    if (full === undefined) throw new Error('no Full workflow segment');
    await act(async () => (full as HTMLElement).click());
    await settle();
    expect(opened.querySelector('div[data-flow]')).not.toBeNull();
    expect(cards(opened)).toEqual([]);
    namesNoProject(opened);
  });

  test('a pack no project stages says so and draws nothing else', async () => {
    const opened = await mount('/console/factory/acme.other/how-it-works', CURATED);
    expect(opened.querySelector('[data-unstaged]')?.textContent).toContain('acme.other');
    expect(cards(opened)).toEqual([]);
    expect(opened.querySelector('div[data-flow]')).toBeNull();
  });
});
