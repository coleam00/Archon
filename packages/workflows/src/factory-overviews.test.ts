import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as bundleInventory from './defaults/bundle-inventory';
import {
  discoverFactoryOverviews,
  resolveFactoryPacks,
  type FactoryPackProject,
} from './factory-overviews';
import { discoverFactoryViews } from './factory-views';
import type { FactoryOverview, FactoryOverviewsListing } from './schemas/factory-overview';
import type { FactoryViewSource } from './schemas/factory-view';
import { DEFAULT_WORKFLOW_SOURCE_CONFIG } from './workflow-source';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

const track = trackTempRoots();
const indexSpy = spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue([]);
afterAll(() => {
  indexSpy.mockRestore();
});

let roots: LiveWorkflowSourceRoots;
let project: string;

beforeEach(async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'archon-factory-overviews-')));
  project = join(root, 'project');
  roots = {
    kind: 'live',
    config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
    project,
    globalWorkflows: join(root, 'home', 'workflows'),
    globalCommands: join(root, 'home', 'commands'),
    globalScripts: join(root, 'home', 'scripts'),
    bundledWorkflows: join(root, 'bundled'),
    installed: { kind: 'receipts', pluginsDir: join(root, 'home', 'plugins') },
  };
});

const overview = (pack: string, title: string): FactoryOverview => ({
  version: 1,
  pack,
  title,
  caption: 'Work comes in and lands.',
  root: 'top',
  views: {
    top: {
      cards: [
        { id: 'a', title: 'A', text: 'In.', icon: 'inbox', kind: 'input', col: 1, row: 1 },
        { id: 'b', title: 'B', text: 'Out.', icon: 'flag', kind: 'outcome', col: 2, row: 1 },
      ],
      edges: [
        { from: 'a', to: 'b', kind: 'feeds' },
        { from: 'b', to: 'a', kind: 'loops-back' },
      ],
    },
  },
});

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
}

const projectFile = (key: string): string =>
  join(project, '.archon', 'packs', `${key}.factory-overview.json`);
const packFile = (pack: string): string =>
  join(project, '.archon', 'workflows', pack, '.shared', 'factory-overview.json');

describe('discoverFactoryOverviews', () => {
  test("finds a project file and a pack's own file", async () => {
    await write(projectFile('acme.kit'), overview('acme/kit', 'From the project'));
    await write(packFile('folder'), overview('folder', 'From the pack'));

    const listing = await discoverFactoryOverviews(roots);
    expect(listing.errors).toEqual([]);
    expect(listing.overviews.map(o => [o.pack, o.source, o.declaration.title, o.path])).toEqual([
      ['acme/kit', 'project-file', 'From the project', projectFile('acme.kit')],
      ['folder', 'project', 'From the pack', packFile('folder')],
    ]);
  });

  test("a project file replaces the pack's own file, and so does a broken one", async () => {
    await write(projectFile('wins'), overview('wins', 'From the project'));
    await write(packFile('wins'), overview('wins', 'From the pack'));
    await write(projectFile('broken'), '{ "version": ');
    await write(packFile('broken'), overview('broken', 'From the pack'));

    const listing = await discoverFactoryOverviews(roots);
    expect(listing.overviews.map(o => [o.pack, o.declaration.title])).toEqual([
      ['wins', 'From the project'],
    ]);
    expect(listing.errors.map(({ pack, source, path }) => [pack, source, path])).toEqual([
      ['broken', 'project-file', projectFile('broken')],
    ]);
  });

  test('an invalid file is listed with its path and the field at fault', async () => {
    const invalid = overview('folder', 'Invalid');
    invalid.root = 'nope';
    await write(packFile('folder'), invalid);

    const listing = await discoverFactoryOverviews(roots);
    expect(listing.overviews).toEqual([]);
    expect(listing.errors[0]?.error).toContain(packFile('folder'));
    // The field at fault, and the value it named.
    expect(listing.errors[0]?.error).toContain('root:');
    expect(listing.errors[0]?.error).toContain('"nope"');
  });

  test('a file naming another pack than where it was found is an error', async () => {
    await write(projectFile('acme.kit'), overview('acme/other', 'Mislabelled'));
    await write(packFile('folder'), overview('elsewhere', 'Mislabelled'));

    const listing = await discoverFactoryOverviews(roots);
    expect(listing.overviews).toEqual([]);
    // Each is listed under where it was found, naming the pack it declared.
    expect(listing.errors.map(({ pack }) => pack)).toEqual(['acme.kit', 'folder']);
    expect(listing.errors[0]?.error).toContain('acme/other');
    expect(listing.errors[1]?.error).toContain('elsewhere');
  });

  test('a factory view file is not read as an overview, nor the reverse', async () => {
    await write(projectFile('acme.kit'), overview('acme/kit', 'Overview'));
    // A view file's name, holding an overview: the view reader refuses it, the overview reader never sees it.
    await write(
      join(project, '.archon', 'packs', 'other.factory-view.json'),
      overview('other', 'x')
    );

    const overviews = await discoverFactoryOverviews(roots);
    expect(overviews.overviews.map(o => o.pack)).toEqual(['acme/kit']);
    expect(overviews.errors).toEqual([]);
    const views = await discoverFactoryViews(roots);
    expect(views.views).toEqual([]);
    expect(views.errors.map(e => e.path)).toEqual([
      join(project, '.archon', 'packs', 'other.factory-view.json'),
    ]);
  });
});

describe('resolveFactoryPacks', () => {
  const listed = (pack: string, source: FactoryViewSource, title = pack) => ({
    pack,
    source,
    path: `/${source}/${pack}`,
    declaration: overview(pack, title),
  });
  const broken = (pack: string, source: FactoryViewSource, path = `/${source}/${pack}`) => ({
    pack,
    source,
    path,
    error: 'bad',
  });
  const none = { overviews: [], errors: [] };
  const project = (
    codebaseId: string,
    listing: FactoryOverviewsListing,
    viewPacks: string[] = []
  ): FactoryPackProject => ({ codebaseId, name: codebaseId, listing, viewPacks });

  test("the pack's own file wins over a project's, with no project named", () => {
    const packs = resolveFactoryPacks({
      home: { overviews: [listed('acme/kit', 'installed', 'Own')], errors: [] },
      projects: [
        project('alpha', {
          // A project listing sees the home file again, and its own file.
          overviews: [listed('acme/kit', 'project-file', 'Project')],
          errors: [],
        }),
      ],
    });
    expect(packs.packs.map(p => [p.key, p.overview?.declaration.title, p.readFrom])).toEqual([
      ['acme.kit', 'Own', null],
    ]);
  });

  test('without its own file, the first project by name gives it and is named', () => {
    const file = (title: string) => ({
      overviews: [listed('acme/kit', 'project-file', title)],
      errors: [],
    });
    const packs = resolveFactoryPacks({
      home: none,
      projects: [project('zeta', file('Zeta')), project('alpha', file('Alpha'))],
    });
    expect(packs.packs.map(p => [p.pack, p.overview?.declaration.title, p.readFrom])).toEqual([
      ['acme/kit', 'Alpha', { codebaseId: 'alpha', name: 'alpha' }],
    ]);
  });

  test("a project's folder pack counts as the project's, and the home file seen again is skipped", () => {
    const packs = resolveFactoryPacks({
      home: none,
      projects: [
        project('alpha', { overviews: [listed('global-only', 'global')], errors: [] }),
        project('beta', { overviews: [listed('folder', 'project')], errors: [] }),
      ],
    });
    // `global-only` in a project listing without a home listing cannot happen; it is skipped
    // rather than credited to the project.
    expect(packs.packs.map(p => [p.key, p.readFrom?.name])).toEqual([['folder', 'beta']]);
  });

  test('no file anywhere lists no pack', () => {
    const packs = resolveFactoryPacks({ home: none, projects: [project('alpha', none, ['x/y'])] });
    expect(packs).toEqual({ packs: [], errors: [], unreadProjects: [] });
  });

  test('a broken pack file falls back to a project file and stays listed on the pack', () => {
    const packs = resolveFactoryPacks({
      home: { overviews: [], errors: [broken('acme/kit', 'installed')] },
      projects: [
        project('alpha', {
          overviews: [listed('acme/kit', 'project-file', 'Project')],
          // Every project re-reads the home files: the same error once.
          errors: [broken('acme/kit', 'installed')],
        }),
      ],
    });
    expect(packs.packs).toHaveLength(1);
    expect(packs.packs[0]?.overview?.declaration.title).toBe('Project');
    expect(packs.packs[0]?.readFrom?.name).toBe('alpha');
    expect(packs.packs[0]?.errors.map(e => e.path)).toEqual(['/installed/acme/kit']);
  });

  test('only broken files list the pack with no overview, under its key', () => {
    const packs = resolveFactoryPacks({
      home: none,
      projects: [project('alpha', { overviews: [], errors: [broken('acme.kit', 'project-file')] })],
    });
    expect(packs.packs.map(p => [p.pack, p.key, p.overview, p.errors.length])).toEqual([
      ['acme.kit', 'acme.kit', null, 1],
    ]);
  });

  test('an unreadable scope root names no pack and is listed once at the top', () => {
    const root = broken('/plugins', 'installed', '/plugins');
    const packs = resolveFactoryPacks({
      home: { overviews: [], errors: [root] },
      projects: [project('alpha', { overviews: [], errors: [root] })],
    });
    expect(packs.packs).toEqual([]);
    expect(packs.errors).toEqual([root]);
  });

  test('a pack lists the projects a view of it applies to, by name', () => {
    const packs = resolveFactoryPacks({
      home: { overviews: [listed('acme/kit', 'installed')], errors: [] },
      projects: [
        project('zeta', none, ['acme/kit']),
        project('alpha', none, ['acme/kit', 'acme/kit']),
        project('mid', none, ['other']),
      ],
    });
    expect(packs.packs[0]?.projects.map(p => p.name)).toEqual(['alpha', 'zeta']);
  });

  test('an unreadable project is listed and the other packs remain', () => {
    const packs = resolveFactoryPacks({
      home: { overviews: [listed('acme/kit', 'installed')], errors: [] },
      projects: [
        { codebaseId: 'gone', name: 'gone', error: 'ENOENT' },
        project('alpha', none, ['acme/kit']),
      ],
    });
    expect(packs.packs.map(p => p.key)).toEqual(['acme.kit']);
    expect(packs.unreadProjects).toEqual([{ codebaseId: 'gone', name: 'gone', error: 'ENOENT' }]);
  });

  test('packs are sorted by title, else key', () => {
    const packs = resolveFactoryPacks({
      home: {
        overviews: [listed('b/one', 'installed', 'Zed'), listed('c/two', 'installed', 'Alpha')],
        errors: [broken('a.broken', 'global', '/a')],
      },
      projects: [],
    });
    expect(packs.packs.map(p => p.key)).toEqual(['a.broken', 'c.two', 'b.one']);
  });
});
