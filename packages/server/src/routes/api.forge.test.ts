import { describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { PluginDiscovery } from '@archon/forge/discovery';
import type {
  ForgeError,
  ForgeRequest,
  ForgeResponse,
  PluginMetadata,
  RepoOverview,
} from '@archon/forge/operations';
import {
  createProjectForgeReader,
  type ProjectCodebase,
  type ProjectForgeDeps,
} from '../services/project-forge';
import { registerProjectForgeRoute } from './api.forge';
import { projectForgeSchema, type ProjectForge } from './schemas/forge.schemas';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');

const github = {
  protocol: 1,
  name: 'github',
  version: '1',
  forge: 'github',
  hosts: ['github.com'],
  capabilities: ['resolve', 'repo.overview'],
  token_env: ['GH_TOKEN'],
  display: { name: 'GitHub', icon: 'PHN2Zy8+' },
  remedies: { unsupported_op: 'Update the plugin.', no_credential: 'Set GH_TOKEN.' },
} satisfies PluginMetadata;
const gitlab = {
  ...github,
  name: 'gitlab',
  version: '3',
  forge: 'gitlab',
  hosts: ['gitlab.example'],
  display: { name: 'GitLab' },
} satisfies PluginMetadata;

const codebases: Record<string, ProjectCodebase> = {
  archon: { id: 'archon', kind: 'repo', repository_url: 'https://github.com/acme/archon.git' },
  lab: { id: 'lab', kind: 'repo', repository_url: 'https://gitlab.example/group/lab.git' },
  unclaimed: { id: 'unclaimed', kind: 'repo', repository_url: 'https://forge.other/a/b.git' },
  folder: { id: 'folder', kind: 'folder', repository_url: null },
};

function overviewOf(host: string, path: string, facts: Partial<RepoOverview> = {}): RepoOverview {
  const url = `https://${host}/${path}`;
  return {
    repo: { host, path },
    since: '2026-11-20T12:00:00.000Z',
    url,
    name: path,
    description: null,
    stars: 4,
    stats: {
      issues_open: { count: 3, url: `${url}/issues` },
      prs_open: { count: 0, url: `${url}/pulls` },
      prs_draft: { count: 1, url: `${url}/pulls?draft` },
    },
    pull_requests: [],
    issues: [],
    ...facts,
  };
}

/** A fake forge: two plugins, and an `repo.overview` answer the test chooses. */
function forgeWorld(overview: (request: ForgeRequest) => RepoOverview | ForgeError) {
  const plugins = [github, gitlab].map(metadata => ({
    metadata,
    command: 'unused',
    args: [],
    source: metadata.name,
    origin: 'source' as const,
  }));
  const discovery: PluginDiscovery = {
    plugins,
    unavailable: [],
    byHost: new Map(plugins.flatMap(plugin => plugin.metadata.hosts.map(host => [host, plugin]))),
    hostConfig: new Map(),
    pluginTokenEnv: new Map(),
  };
  const calls: { op: string; user: string | undefined }[] = [];
  let now = NOW;
  let discoveries = 0;
  const deps: ProjectForgeDeps = {
    discover: async () => {
      discoveries++;
      return discovery;
    },
    dispatch: async (request, options) => {
      calls.push({ op: request.op, user: options.credentialEnv?.FORGE_USER });
      const answer = (response: object): { response: ForgeResponse } => ({
        response: { operationId: request.operationId, ...response } as ForgeResponse,
      });
      if (request.op === 'resolve') {
        const { host, pathname } = new URL(request.remote ?? '');
        const plugin = discovery.byHost.get(host)?.metadata;
        const value = plugin
          ? {
              kind: 'resolved',
              forge: plugin.forge,
              repo: { host, path: pathname.slice(1).replace(/\.git$/, '') },
              plugin: { name: plugin.name, version: plugin.version },
            }
          : { kind: 'none', forge: 'none' };
        return answer({ ok: true, result: { op: 'resolve', value } });
      }
      const result = overview(request);
      return 'kind' in result
        ? answer({ ok: false, error: result })
        : answer({ ok: true, result: { op: 'repo.overview', value: result } });
    },
    credentialEnv: async (_codebase, userId) => ({ FORGE_USER: userId }),
    now: () => new Date(now),
  };
  const read = createProjectForgeReader(deps);
  const app = new OpenAPIHono();
  registerProjectForgeRoute(app, {
    getCodebase: async id => codebases[id] ?? null,
    userId: async c => c.req.header('x-test-user'),
    readProjectForge: read,
  });
  return {
    get: async (id: string, user?: string) => {
      const response = await app.request(`/api/codebases/${id}/forge`, {
        headers: user ? { 'x-test-user': user } : {},
      });
      return { status: response.status, body: (await response.json()) as ProjectForge };
    },
    overviews: () => calls.filter(call => call.op === 'repo.overview'),
    discoveries: () => discoveries,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const answering = () =>
  forgeWorld(request =>
    request.op === 'repo.overview'
      ? overviewOf(request.repo.host, request.repo.path, { since: request.since })
      : { kind: 'invalid_request', message: 'unexpected operation' }
  );
const failing = (error: ForgeError) => forgeWorld(() => error);

describe('GET /api/codebases/{id}/forge', () => {
  test('a GitHub-backed project answers its forge, plugin and overview', async () => {
    const world = answering();
    const { status, body } = await world.get('archon');
    expect(status).toBe(200);
    expect(projectForgeSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      kind: 'forge',
      forge: { id: 'github', name: 'GitHub', icon: 'PHN2Zy8+' },
      repo: { host: 'github.com', path: 'acme/archon' },
      plugin: { name: 'github', version: '1' },
      overview: {
        status: 'ok',
        syncedAt: '2026-11-27T12:00:00.000Z',
        // The window the server asks for is the seven days before now.
        value: { name: 'acme/archon', since: '2026-11-20T12:00:00.000Z' },
      },
    });
  });

  test('another forge is labelled by its own plugin, through the same path', async () => {
    const { body } = await answering().get('lab');
    expect(body).toMatchObject({
      kind: 'forge',
      forge: { id: 'gitlab', name: 'GitLab' },
      repo: { host: 'gitlab.example', path: 'group/lab' },
      plugin: { name: 'gitlab', version: '3' },
      overview: { status: 'ok', value: { url: 'https://gitlab.example/group/lab' } },
    });
    expect(body.kind === 'forge' && 'icon' in body.forge).toBe(false);
  });

  test('a folder project and a remote no plugin claims have no forge', async () => {
    const world = answering();
    expect(await world.get('folder')).toEqual({ status: 200, body: { kind: 'none' } });
    expect(world.discoveries()).toBe(0);
    expect(await world.get('unclaimed')).toEqual({ status: 200, body: { kind: 'none' } });
    expect(world.overviews()).toHaveLength(0);
  });

  test('a fact the forge lacks is absent, and a zero count is present', async () => {
    const world = forgeWorld(request => {
      if (request.op !== 'repo.overview') throw new Error('unexpected operation');
      const { stars: _stars, stats, ...facts } = overviewOf(request.repo.host, request.repo.path);
      const { prs_draft: _drafts, ...reported } = stats;
      return { ...facts, stats: reported };
    });
    const { body } = await world.get('archon');
    if (body.kind !== 'forge' || body.overview.status !== 'ok') throw new Error('no overview');
    expect('stars' in body.overview.value).toBe(false);
    expect(Object.keys(body.overview.value.stats)).toEqual(['issues_open', 'prs_open']);
    expect(body.overview.value.stats.prs_open?.count).toBe(0);
  });

  test('a plugin that predates the operation fails the overview with its remedy', async () => {
    const { status, body } = await failing({
      kind: 'unsupported_op',
      message: 'plugin github does not support repo.overview',
    }).get('archon');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      kind: 'forge',
      forge: { name: 'GitHub' },
      overview: {
        status: 'failed',
        error: { kind: 'unsupported_op' },
        remedy: 'Update the plugin.',
      },
    });
  });

  test('a forge error is a failed overview with its kind, never an empty one', async () => {
    for (const kind of ['authorization', 'rate_limited', 'unavailable'] as const) {
      const { body } = await failing({ kind, message: `the forge said ${kind}` }).get('archon');
      expect(body).toMatchObject({
        kind: 'forge',
        overview: { status: 'failed', error: { kind, message: `the forge said ${kind}` } },
      });
      expect(JSON.stringify(body)).not.toContain('"count"');
    }
    const { body } = await failing({ kind: 'no_credential', message: 'no token' }).get('archon');
    expect(body).toMatchObject({ overview: { status: 'failed', remedy: 'Set GH_TOKEN.' } });
  });

  test('a plugin process failure never returns what the process printed', async () => {
    const { body } = await failing({
      kind: 'process_failed',
      message: 'plugin exited 1: token ghp_leaked in stderr',
      exitCode: 1,
    }).get('archon');
    expect(body).toMatchObject({
      overview: { status: 'failed', error: { kind: 'process_failed' } },
    });
    expect(JSON.stringify(body)).not.toContain('ghp_leaked');
  });

  test('one read answers a project and user for a minute, and a failure is read again', async () => {
    const world = answering();
    await world.get('archon', 'ada');
    await world.get('archon', 'ada');
    expect(world.overviews()).toEqual([{ op: 'repo.overview', user: 'ada' }]);

    await world.get('archon', 'grace');
    expect(world.overviews().map(call => call.user)).toEqual(['ada', 'grace']);

    world.advance(61_000);
    await world.get('archon', 'ada');
    expect(world.overviews().map(call => call.user)).toEqual(['ada', 'grace', 'ada']);

    const broken = failing({ kind: 'authorization', message: 'bad credentials' });
    await broken.get('archon');
    await broken.get('archon');
    expect(broken.overviews()).toHaveLength(2);
  });

  test('an unknown codebase is not found', async () => {
    expect((await answering().get('missing')).status).toBe(404);
  });
});
