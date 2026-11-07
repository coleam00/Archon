// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Codebase } from '@archon/core/schemas/codebase';
import { clearConfigCache } from '@archon/core';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';

const codebases = new Map<string, Codebase>();
const realCodebaseDb = { ...(await import('@archon/core/db/codebases')) };
mock.module('@archon/core/db/codebases', () => ({
  ...realCodebaseDb,
  getCodebase: async (id: string) => codebases.get(id) ?? null,
}));

const { registerConfigRoutes } = await import('./api.config');
const { projectConfigResponseSchema } = await import('./schemas/config.schemas');

registerBuiltinProviders();
const trackTempRoot = trackTempRoots();

const ENV_SECRET = 'env-secret-sentinel-7f3a';
const PATH_SECRET = '/assistant-path-sentinel-9c1e';

const GLOBAL_CONFIG = `aliases:
  '@planner':
    provider: claude
    model: haiku
  '@reviewer':
    provider: claude
    model: sonnet
`;

const REPO_CONFIG = `aliases:
  '@planner':
    provider: claude
    model: opus
tiers:
  large:
    provider: claude
    model: opus
assistants:
  codex:
    additionalDirectories:
      - ${PATH_SECRET}
env:
  FORGE_SOURCE: gh
  SECRET_TOKEN: ${ENV_SECRET}
`;

let home: string;
let project: string;
const savedHome = process.env.ARCHON_HOME;

beforeEach(() => {
  setPlatformPolicies([]);
  clearConfigCache();
  home = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-home-')));
  project = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-project-')));
  process.env.ARCHON_HOME = home;
  writeFileSync(join(home, 'config.yaml'), GLOBAL_CONFIG);
  mkdirSync(join(project, '.archon'));
  writeFileSync(join(project, '.archon', 'config.yaml'), REPO_CONFIG);
  codebases.clear();
  codebases.set('cb-1', {
    id: 'cb-1',
    name: 'acme/widget',
    kind: 'repo',
    repository_url: null,
    default_cwd: project,
    default_branch: null,
    ai_assistant_type: null,
    commands: {},
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    updated_at: new Date('2026-10-01T00:00:00.000Z'),
  });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = savedHome;
  clearConfigCache();
});

function app(): OpenAPIHono {
  const app = new OpenAPIHono();
  registerConfigRoutes(app);
  return app;
}

/** Every file under `root` with its bytes, so a read can be shown to change nothing. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path] = readFileSync(path, 'utf8');
  }
  return files;
}

describe('GET /api/codebases/{id}/config', () => {
  test("returns the project's merged config with env key names only", async () => {
    const response = await app().request('/api/codebases/cb-1/config');
    expect(response.status).toBe(200);
    const body = projectConfigResponseSchema.parse(await response.json());
    expect(body.config.aliases).toEqual({
      '@planner': { provider: 'claude', model: 'opus' },
      '@reviewer': { provider: 'claude', model: 'sonnet' },
    });
    expect(body.config.tiers?.large).toEqual({ provider: 'claude', model: 'opus' });
    expect(body.envKeys).toEqual(['FORGE_SOURCE', 'SECRET_TOKEN']);
  });

  test('never returns a secret value', async () => {
    const response = await app().request('/api/codebases/cb-1/config');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(ENV_SECRET);
    expect(text).not.toContain(PATH_SECRET);
  });

  test('a read changes no file', async () => {
    const before = { ...snapshot(home), ...snapshot(project) };
    expect((await app().request('/api/codebases/cb-1/config')).status).toBe(200);
    expect({ ...snapshot(home), ...snapshot(project) }).toEqual(before);
  });

  test('a read does not create a missing global config', async () => {
    rmSync(join(home, 'config.yaml'));
    expect((await app().request('/api/codebases/cb-1/config')).status).toBe(200);
    expect(readdirSync(home)).toEqual([]);
  });

  test('an unknown project is 404', async () => {
    const response = await app().request('/api/codebases/nope/config');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Codebase not found' });
  });

  test('an invalid project config is 422 and names no server path', async () => {
    writeFileSync(join(project, '.archon', 'config.yaml'), 'tiers:\n  huge:\n    model: x\n');
    const response = await app().request('/api/codebases/cb-1/config');
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toContain('tiers');
    expect(text).not.toContain(project);
  });

  test.each([
    ['not valid YAML', 'tiers: [unclosed\n', 'Project config is not valid YAML'],
    ['not a map', '- botName: x\n', 'Project config is not a map'],
    ['an unregistered assistant', 'assistant: nope\n', 'Invalid assistant'],
    ['a bad worktree.postCreate', 'worktree:\n  postCreate: [""]\n', 'Invalid worktree config'],
  ])('a project config with %s is 422 and names no server path', async (_, content, summary) => {
    writeFileSync(join(project, '.archon', 'config.yaml'), content);
    const response = await app().request('/api/codebases/cb-1/config');
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toContain(summary);
    expect(text).not.toContain(project);
  });

  // Bun's YAML errors quote no source today; this fails if an upgrade starts to.
  test('a malformed file holding a secret is 422 without the secret', async () => {
    writeFileSync(
      join(project, '.archon', 'config.yaml'),
      `env:\n  SECRET_TOKEN: ${ENV_SECRET}\n  bad: [unclosed\n`
    );
    const response = await app().request('/api/codebases/cb-1/config');
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(ENV_SECRET);
  });

  test('a broken global config is 422 and says it is the global file', async () => {
    writeFileSync(join(home, 'config.yaml'), 'botName: [unclosed\n');
    const response = await app().request('/api/codebases/cb-1/config');
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).toContain('Global config is not valid YAML');
    expect(text).not.toContain(home);
  });
});
