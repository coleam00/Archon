import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { readPackGraph } from '@archon/core/workflows/pack-graph';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerPackGraphRoute } from './api.packs';
import { packGraphResponseSchema } from './schemas/workflow.schemas';

const track = trackTempRoots();

async function graphApp(): Promise<OpenAPIHono> {
  const project = track(await mkdtemp(join(tmpdir(), 'archon-pack-graph-route-')));
  const stage = join(project, '.archon', 'workflows', 'chain', 'chain-a');
  await mkdir(stage, { recursive: true });
  await writeFile(
    join(stage, 'chain-a.yaml'),
    'name: chain-a\ndescription: a\nnodes:\n  - id: work\n    bash: "true"\n'
  );
  const app = new OpenAPIHono();
  registerPackGraphRoute(app, {
    codebaseCwd: async id => (id === 'cb-1' ? project : null),
    readPackGraph: (cwd, pack) =>
      readPackGraph(cwd, pack, {
        loadConfig: async () => ({
          assistant: undefined,
          commands: {},
          assistants: { claude: {}, codex: {} },
        }),
        providers: providerRegistry,
        triggersDirectory: () => join(project, 'no-triggers'),
        projectKeyOf: async () => null,
      }),
  });
  return app;
}

describe('GET /api/packs/{pack}/graph', () => {
  test("a codebase's pack is served in the served schema", async () => {
    const response = await (await graphApp()).request('/api/packs/chain/graph?codebaseId=cb-1');
    expect(response.status).toBe(200);
    const graph = packGraphResponseSchema.parse(await response.json());
    expect(graph.stages.map(stage => [stage.name, stage.nodes.map(node => node.id)])).toEqual([
      ['chain-a', ['work']],
    ]);
  });

  test('an unknown codebase or pack returns 404', async () => {
    const app = await graphApp();
    expect((await app.request('/api/packs/chain/graph?codebaseId=missing')).status).toBe(404);
    expect((await app.request('/api/packs/nope/graph?codebaseId=cb-1')).status).toBe(404);
  });
});
