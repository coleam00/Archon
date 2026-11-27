import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Project } from '../../primitives/project';
import { invalidate, set } from '../../store/cache';
import { K } from '../../store/keys';
import type { PackGraph } from '../../skills/items';
import { testGraph } from '../curated.test-fixtures';
import { installDom } from '../test-dom.test-helpers';

const { mount: mountTree, settle } = await installDom();
// Loaded after the window exists: react-dom reads it when it loads.
const { FactoryHome, HowItWorksPage } = await import('./HowItWorksPage');

const PACK = 'Wirasm.archon-software-factory';

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
  for (const prefix of ['projects', 'pack-graph']) invalidate(prefix);
});

/** Mounts the sidebar's Factory routes at `at`, the pack staged by the second project. */
async function mount(at: string, graph: PackGraph = DOCUMENTED): Promise<HTMLElement> {
  set(K.projects, [project('cb-0', []), project('cb-1', [PACK])]);
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

/** The pack's document below its front matter, as the graph serves it. */
const TEXT = [
  '# How the factory works',
  '',
  'Work comes in as a **work order**.',
  '',
  '## How work gets in',
  '',
  '- **An issue.** Someone labels it.',
  '- **Found by agents.** Filed as new work.',
].join('\n');
const DOCUMENTED: PackGraph = {
  ...testGraph,
  document: { path: 'how-it-works.md', problems: [], text: TEXT },
};
const page = `/console/factory/${PACK}/how-it-works`;

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
    const opened = await mount('/console/factory');
    expect(opened.querySelector('h1')?.textContent).toBe('Archon software factory');
    expect(opened.querySelector('[data-document]')).not.toBeNull();
  });

  test('the header names the pack as a person reads it, with the raw key on hover', async () => {
    const opened = await mount(page);
    const title = opened.querySelector('h1');
    expect(title?.textContent).toBe('Archon software factory');
    expect(title?.getAttribute('title')).toBe(PACK);
  });

  test("the How it works section is the pack's document: its headings, paragraphs and list", async () => {
    const opened = await mount(page);
    const section = opened.querySelector('section[aria-label="How it works"]');
    expect(section?.querySelector('h1')?.textContent).toBe('How the factory works');
    expect(section?.querySelector('p strong')?.textContent).toBe('work order');
    expect(section?.querySelector('div h2')?.textContent).toBe('How work gets in');
    expect([...(section?.querySelectorAll('li') ?? [])].map(item => item.textContent)).toEqual([
      'An issue. Someone labels it.',
      'Found by agents. Filed as new work.',
    ]);
    // The whole workflow follows it, derived from the graph and naming no project.
    expect(opened.querySelector('div[data-flow]')).not.toBeNull();
    namesNoProject(opened);
  });

  test('a pack with no document shows no How it works section, only its workflow', async () => {
    const opened = await mount(page, { ...testGraph, document: null });
    expect(opened.querySelector('section[aria-label="How it works"]')).toBeNull();
    expect(opened.querySelector('[data-document]')).toBeNull();
    expect(opened.querySelector('div[data-flow]')).not.toBeNull();
    namesNoProject(opened);
  });

  test("the document's problems show above it, in one line that opens to the list", async () => {
    const problem = "stage 'stage-host' is in no group";
    const opened = await mount(page, {
      ...DOCUMENTED,
      document: { path: 'how-it-works.md', problems: [problem], text: TEXT },
    });
    const listed = opened.querySelector('[data-document-problems]');
    expect(listed?.querySelector('li')?.textContent).toBe(problem);
  });

  test('a pack no project stages says so and draws nothing else', async () => {
    const opened = await mount('/console/factory/acme.other/how-it-works');
    expect(opened.querySelector('[data-unstaged]')?.textContent).toContain('acme.other');
    expect(opened.querySelector('[data-document]')).toBeNull();
    expect(opened.querySelector('div[data-flow]')).toBeNull();
  });
});
