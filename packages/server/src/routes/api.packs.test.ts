import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { readPackGraph } from '@archon/core/workflows/pack-graph';
import { readPackView } from '@archon/core/workflows/pack-view';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerPackGraphRoute, registerPackViewRoute } from './api.packs';
import { packGraphResponseSchema, packViewResponseSchema } from './schemas/workflow.schemas';

const track = trackTempRoots();

/** A codebase whose `chain` pack holds chain-a and `packFiles` (paths inside the pack). */
async function graphApp(
  triggers: Record<string, string> = {},
  packFiles: Record<string, string> = {}
): Promise<OpenAPIHono> {
  const project = track(await mkdtemp(join(tmpdir(), 'archon-pack-graph-route-')));
  const pack = join(project, '.archon', 'workflows', 'chain');
  const files = {
    'chain-a/chain-a.yaml':
      'name: chain-a\ndescription: a\nnodes:\n  - id: work\n    bash: "true"\n',
    ...packFiles,
  };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(pack, path)), { recursive: true });
    await writeFile(join(pack, path), body);
  }
  const triggersDirectory = join(project, 'triggers');
  await mkdir(triggersDirectory, { recursive: true });
  for (const [name, body] of Object.entries(triggers))
    await writeFile(join(triggersDirectory, name), body);
  const app = new OpenAPIHono();
  const deps = {
    loadConfig: async () => ({
      assistant: undefined,
      commands: {},
      assistants: { claude: {}, codex: {} },
    }),
    providers: providerRegistry,
    triggersDirectory: () => triggersDirectory,
    projectKeyOf: async () => null,
    projectOf: async () => null,
  };
  const codebaseCwd = async (id: string) => (id === 'cb-1' ? project : null);
  registerPackGraphRoute(app, {
    codebaseCwd,
    readPackGraph: (cwd, pack) => readPackGraph(cwd, pack, deps),
  });
  registerPackViewRoute(app, {
    codebaseCwd,
    readPackView: (cwd, pack) => readPackView(cwd, pack, deps),
  });
  return app;
}

describe('GET /api/packs/{pack}/graph', () => {
  test("a codebase's pack is served in the served schema", async () => {
    const response = await (await graphApp()).request('/api/packs/chain/graph?codebaseId=cb-1');
    expect(response.status).toBe(200);
    packGraphResponseSchema.parse(await response.json());
  });

  test("the pack's own overview cards are served, and a file that does not validate is a problem", async () => {
    const cards = {
      names: { 'x.done': 'done' },
      cards: [{ shape: 'count', title: 'Done', metric: 'x.done' }],
    };
    const read = async (file: string): Promise<unknown> => {
      const app = await graphApp({}, { '.shared/metric-views.json': file });
      const response = await app.request('/api/packs/chain/graph?codebaseId=cb-1');
      return packGraphResponseSchema.parse(await response.json()).metricViews;
    };
    expect(await read(JSON.stringify(cards))).toEqual({ ...cards, problem: null });
    const broken = (await read('{"cards": []}')) as { cards: unknown[]; problem: string | null };
    expect([broken.cards, broken.problem === null]).toEqual([[], false]);
    const none = await (await graphApp()).request('/api/packs/chain/graph?codebaseId=cb-1');
    expect(packGraphResponseSchema.parse(await none.json()).metricViews).toBeNull();
  });

  test('a declared stage that fails to load is served with its load error, not a 500', async () => {
    const app = await graphApp(
      {},
      {
        '.pack/pack.yaml':
          'bindings:\n  next:\n    workflow: chain-b\n    resource: b\n    overlap: queue\n    run_ended: { workflow: chain-a, outcome: succeeded }\n',
        'chain-b/chain-b.yaml':
          'name: chain-b\ndescription: b\nnodes:\n  - id: w\n    include: missing-block\n',
      }
    );
    const response = await app.request('/api/packs/chain/graph?codebaseId=cb-1');
    expect(response.status).toBe(200);
    const graph = packGraphResponseSchema.parse(await response.json());
    expect(graph.discoveryErrors.map(e => e.filename)).toContain('chain-b.yaml');
  });

  test('an unreadable trigger file is 422 naming the file, as the CLI names it', async () => {
    const app = await graphApp({ 'broken.json': '{ not json' });
    const response = await app.request('/api/packs/chain/graph?codebaseId=cb-1');
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain('broken.json');
  });

  test('an unknown codebase or pack returns 404', async () => {
    const app = await graphApp();
    expect((await app.request('/api/packs/chain/graph?codebaseId=missing')).status).toBe(404);
    expect((await app.request('/api/packs/nope/graph?codebaseId=cb-1')).status).toBe(404);
  });
});

describe('GET /api/packs/{pack}/view', () => {
  test('a pack that ships no view is 200 with a null view, a null path and no problems', async () => {
    const response = await (await graphApp()).request('/api/packs/chain/view?codebaseId=cb-1');
    expect(response.status).toBe(200);
    expect(packViewResponseSchema.parse(await response.json())).toEqual({
      path: null,
      view: null,
      problems: [],
    });
  });

  test('an unknown pack is 404 and a relative workflowSource is 400, as for the graph', async () => {
    const app = await graphApp();
    expect((await app.request('/api/packs/nope/view?codebaseId=cb-1')).status).toBe(404);
    const relative = await app.request('/api/packs/chain/view?codebaseId=cb-1&workflowSource=src');
    expect(relative.status).toBe(400);
  });
});
