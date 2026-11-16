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

async function graphApp(triggers: Record<string, string> = {}): Promise<OpenAPIHono> {
  const project = track(await mkdtemp(join(tmpdir(), 'archon-pack-graph-route-')));
  const stage = join(project, '.archon', 'workflows', 'chain', 'chain-a');
  await mkdir(stage, { recursive: true });
  await writeFile(
    join(stage, 'chain-a.yaml'),
    'name: chain-a\ndescription: a\nnodes:\n  - id: work\n    bash: "true"\n'
  );
  const triggersDirectory = join(project, 'triggers');
  await mkdir(triggersDirectory, { recursive: true });
  for (const [name, body] of Object.entries(triggers))
    await writeFile(join(triggersDirectory, name), body);
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
        triggersDirectory: () => triggersDirectory,
        projectKeyOf: async () => null,
      }),
  });
  return app;
}

describe('GET /api/packs/{pack}/graph', () => {
  test("a codebase's pack is served in the served schema", async () => {
    const response = await (await graphApp()).request('/api/packs/chain/graph?codebaseId=cb-1');
    expect(response.status).toBe(200);
    packGraphResponseSchema.parse(await response.json());
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
