import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as bundleInventory from './defaults/bundle-inventory';
import { discoverMetricViews } from './metric-views';
import { DEFAULT_WORKFLOW_SOURCE_CONFIG } from './workflow-source';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

const track = trackTempRoots();
const indexSpy = spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue(['factory']);
afterAll(() => {
  indexSpy.mockRestore();
});

let root: string;
let roots: LiveWorkflowSourceRoots;

beforeEach(async () => {
  root = track(await mkdtemp(join(tmpdir(), 'archon-metric-views-')));
  roots = {
    kind: 'live',
    config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
    project: join(root, 'project'),
    globalWorkflows: join(root, 'home', 'workflows'),
    globalCommands: join(root, 'home', 'commands'),
    globalScripts: join(root, 'home', 'scripts'),
    bundledWorkflows: join(root, 'bundled'),
    installed: { kind: 'receipts', pluginsDir: join(root, 'home', 'plugins') },
  };
});

const card = (title: string): object => ({ shape: 'count', title, metric: 'factory.items' });

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
}

const declaration = (packDir: string): string => join(packDir, '.shared', 'metric-views.json');

test('a project pack replaces a same-named bundled pack and sits beside other scopes', async () => {
  await write(declaration(join(roots.bundledWorkflows, 'factory')), { cards: [card('Bundled')] });
  await write(declaration(join(roots.project ?? '', '.archon', 'workflows', 'factory')), {
    names: { 'factory.items': 'Items' },
    cards: [card('Project')],
  });
  await write(declaration(join(roots.globalWorkflows, 'home-pack')), { cards: [card('Home')] });
  // A pack folder with no declaration declares nothing.
  await mkdir(join(roots.globalWorkflows, 'quiet', 'flow'), { recursive: true });

  const listing = await discoverMetricViews(roots);
  expect(listing.errors).toEqual([]);
  expect(listing.packs.map(({ pack, source, cards }) => [pack, source, cards[0]?.title])).toEqual([
    ['home-pack', 'global', 'Home'],
    ['factory', 'project', 'Project'],
  ]);
  expect(listing.packs[1]?.names).toEqual({ 'factory.items': 'Items' });
});

test('the bundled scope follows the roots config', async () => {
  await write(declaration(join(roots.bundledWorkflows, 'factory')), { cards: [card('Bundled')] });
  expect((await discoverMetricViews(roots)).packs.map(p => p.source)).toEqual(['bundled']);
  const without = await discoverMetricViews({
    ...roots,
    config: { ...DEFAULT_WORKFLOW_SOURCE_CONFIG, load_default_workflows: false },
  });
  expect(without.packs).toEqual([]);
});

test('a broken declaration is an error naming its pack, and other packs still list', async () => {
  const workflows = join(roots.project ?? '', '.archon', 'workflows');
  await write(declaration(join(workflows, 'not-json')), '{ cards: ');
  await write(declaration(join(workflows, 'bad-shape')), {
    cards: [{ shape: 'gauge', title: 'Speed', metric: 'factory.items' }],
  });
  await write(declaration(join(workflows, 'good')), { cards: [card('Good')] });

  const listing = await discoverMetricViews(roots);
  expect(listing.packs.map(p => p.pack)).toEqual(['good']);
  expect(listing.errors.map(({ pack, source }) => [pack, source])).toEqual([
    ['bad-shape', 'project'],
    ['not-json', 'project'],
  ]);
  expect(listing.errors[0]?.error).toContain('cards.0.shape');
  expect(listing.errors[1]?.error).toContain('is not JSON');
});

test('a scope root that cannot be read is an error, and other scopes still list', async () => {
  await write(roots.globalWorkflows, 'not a folder');
  await write(declaration(join(roots.project ?? '', '.archon', 'workflows', 'good')), {
    cards: [card('Good')],
  });

  const listing = await discoverMetricViews(roots);
  expect(listing.packs.map(p => p.pack)).toEqual(['good']);
  expect(listing.errors.map(({ pack, source }) => [pack, source])).toEqual([
    [roots.globalWorkflows, 'global'],
  ]);
});

test('an unreadable bundle index is a bundled error, and other scopes still list', async () => {
  indexSpy.mockRejectedValueOnce(new Error('bundle-index.json: Duplicate bundle pack'));
  await write(declaration(join(roots.globalWorkflows, 'mine')), { cards: [card('Mine')] });

  const listing = await discoverMetricViews(roots);
  expect(listing.packs.map(p => p.pack)).toEqual(['mine']);
  expect(listing.errors).toEqual([
    {
      pack: roots.bundledWorkflows,
      source: 'bundled',
      error: 'bundle-index.json: Duplicate bundle pack',
    },
  ]);
});

test('an installed pack lists as owner/name', async () => {
  const pluginsDir = join(root, 'home', 'plugins');
  const id = 'acme/packs/factory-kit';
  const commit = 'a'.repeat(40);
  const manifest = {
    schemaVersion: 1,
    kind: 'workflow-pack',
    name: 'factory-kit',
    description: 'fixture pack',
    entrypoints: { count: 'count/count.yaml' },
  };
  const tree = packTreePath(pluginsDir, id, commit);
  await write(join(tree, 'archon-plugin.json'), manifest);
  await write(join(tree, 'count', 'count.yaml'), 'name: count\nnodes: []\n');
  await write(declaration(tree), { cards: [card('Installed')] });
  await write(receiptPath(pluginsDir, id), {
    schemaVersion: 1,
    id,
    manifest,
    commit,
    installedAt: new Date(0).toISOString(),
  });

  const listing = await discoverMetricViews(roots);
  expect(listing.errors).toEqual([]);
  expect(listing.packs.map(({ pack, source }) => [pack, source])).toEqual([
    ['acme/factory-kit', 'installed'],
  ]);
});
