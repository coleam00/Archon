import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as bundleInventory from './defaults/bundle-inventory';
import {
  discoverFactoryViews,
  factoryViewWorkflowNames,
  factoryViewsForProject,
} from './factory-views';
import type { FactoryView, FactoryViewsListing } from './schemas/factory-view';
import { DEFAULT_WORKFLOW_SOURCE_CONFIG } from './workflow-source';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

const track = trackTempRoots();
const indexSpy = spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue([]);
afterAll(() => {
  indexSpy.mockRestore();
});

let root: string;
let roots: LiveWorkflowSourceRoots;
let project: string;

beforeEach(async () => {
  root = track(await mkdtemp(join(tmpdir(), 'archon-factory-views-')));
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

const view = (pack: string, title: string): FactoryView => ({
  version: 1,
  pack,
  title,
  summary: 'Items in, changes out.',
  stages: [
    { id: 'build', label: 'Build', blurb: 'Builds.', group: 'build', workflows: ['deliver'] },
    { id: 'landed', label: 'Landed', blurb: 'Merged.', group: 'land', workflows: [] },
  ],
  placement: { 'deliver:ready': 'landed' },
  endings: {},
  landed: { stage: 'landed' },
  map: { cards: [{ stage: 'build' }], arrows: [] },
});

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
}

const projectFile = (key: string): string =>
  join(project, '.archon', 'packs', `${key}.factory-view.json`);
const packFile = (pack: string): string =>
  join(project, '.archon', 'workflows', pack, '.shared', 'factory-view.json');

describe('discoverFactoryViews', () => {
  test("a project file replaces the same pack's own view, beside other packs' views", async () => {
    await write(packFile('factory'), view('factory', 'From the pack'));
    await write(projectFile('factory'), view('factory', 'From the project'));
    await write(packFile('other'), view('other', 'Other'));
    // Pack settings share the folder and are not views.
    await write(join(project, '.archon', 'packs', 'factory.yaml'), 'settings: {}\n');

    const listing = await discoverFactoryViews(roots);
    expect(listing.errors).toEqual([]);
    expect(listing.views.map(v => [v.pack, v.source, v.declaration.title, v.path])).toEqual([
      ['factory', 'project-file', 'From the project', projectFile('factory')],
      ['other', 'project', 'Other', packFile('other')],
    ]);
  });

  test('each view names its pack key and the run name of every workflow a stage lists', async () => {
    await write(projectFile('acme.kit'), view('acme/kit', 'Installed'));
    await write(packFile('folder'), view('folder', 'Folder'));

    const listing = await discoverFactoryViews(roots);
    expect(listing.views.map(v => [v.pack, v.packKey, v.runNames])).toEqual([
      ['acme/kit', 'acme.kit', { deliver: 'acme/kit:deliver' }],
      ['folder', 'folder', { deliver: 'deliver' }],
    ]);
  });

  test('a malformed file is an error with its path and issue, and other views still list', async () => {
    const broken = view('factory', 'Broken');
    broken.placement = { 'deliver:ready': 'nowhere' };
    await write(projectFile('factory'), broken);
    await write(packFile('factory'), view('factory', 'From the pack'));
    await write(packFile('bad-json'), '{ "version": ');
    await write(packFile('good'), view('good', 'Good'));

    const listing = await discoverFactoryViews(roots);
    // A broken project file still replaces the pack's own view; its error shows instead.
    expect(listing.views.map(v => v.pack)).toEqual(['good']);
    expect(listing.errors.map(({ pack, source, path }) => [pack, source, path])).toEqual([
      ['factory', 'project-file', projectFile('factory')],
      ['bad-json', 'project', packFile('bad-json')],
    ]);
    // Each error names its file, and the schema error names the field at fault.
    expect(listing.errors[0]?.error).toContain(projectFile('factory'));
    expect(listing.errors[0]?.error).toContain('placement.deliver:ready');
    expect(listing.errors[1]?.error).toContain(packFile('bad-json'));
  });

  test('a declaration naming another pack than its file is an error', async () => {
    await write(projectFile('acme.kit'), view('acme/other', 'Mislabelled'));
    await write(packFile('folder'), view('elsewhere', 'Mislabelled'));

    const listing = await discoverFactoryViews(roots);
    // Both are refused, each listed under its file and naming the pack it declared.
    expect(listing.views).toEqual([]);
    expect(listing.errors.map(({ pack, source, path }) => [pack, source, path])).toEqual([
      ['acme.kit', 'project-file', projectFile('acme.kit')],
      ['folder', 'project', packFile('folder')],
    ]);
    expect(listing.errors[0]?.error).toContain('acme/other');
    expect(listing.errors[1]?.error).toContain('elsewhere');
  });
});

describe('factoryViewsForProject', () => {
  const listed = (
    pack: string,
    source: FactoryViewsListing['views'][number]['source']
  ): FactoryViewsListing['views'][number] => ({
    pack,
    packKey: pack,
    runNames: {},
    source,
    path: `/${pack}`,
    declaration: view(pack, pack),
  });
  const listing: FactoryViewsListing = {
    views: [
      listed('presented', 'project-file'),
      listed('acme/kit', 'installed'),
      listed('folder', 'project'),
    ],
    errors: [{ pack: 'broken', source: 'project-file', path: '/broken', error: 'is invalid' }],
  };
  const applying = (ran: string[]): string[] =>
    factoryViewsForProject(listing, new Set(ran)).views.map(v => v.pack);

  test('a project file applies with no runs; errors always pass through', () => {
    const result = factoryViewsForProject(listing, new Set());
    expect(result.views.map(v => v.pack)).toEqual(['presented']);
    expect(result.errors).toEqual(listing.errors);
  });

  test("a pack's own view applies once the project ran a workflow it names, by its run name", () => {
    expect(applying(['acme/kit:deliver'])).toEqual(['presented', 'acme/kit']);
    expect(applying(['deliver'])).toEqual(['presented', 'folder']);
    expect(applying(['acme/kit:plan', 'other/kit:deliver'])).toEqual(['presented']);
  });

  test('the run names to look up are each view workflow as its runs record it', () => {
    expect(factoryViewWorkflowNames(listing).sort()).toEqual(['acme/kit:deliver', 'deliver']);
  });
});
