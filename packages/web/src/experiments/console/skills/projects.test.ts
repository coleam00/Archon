import { afterEach, expect, test } from 'bun:test';
import {
  addProjectByPath,
  addProjectByUrl,
  inspectProjectBaseBranch,
  renameProject,
} from './projects';
import { toProject } from '../primitives/project';
import type { components } from '../../../lib/api.generated';

const raw: components['schemas']['Codebase'] = {
  id: 'project',
  name: 'owner/repo',
  default_cwd: '/repo',
  repository_url: null,
  default_branch: null,
  kind: 'repo',
  ai_assistant_type: 'claude',
  commands: {},
  created_at: '2026-10-04T00:00:00Z',
  updated_at: '2026-10-04T00:00:00Z',
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('normalization preserves unset and explicit branch choices without inventing main', () => {
  expect(toProject(raw).defaultBranch).toBeNull();
  expect(toProject({ ...raw, default_branch: 'release' }).defaultBranch).toBe('release');
});

test('registration sends null for the default and the explicit branch unchanged', async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as unknown);
    return Promise.resolve(
      new Response(JSON.stringify(raw), { headers: { 'Content-Type': 'application/json' } })
    );
  }) as typeof fetch;
  await addProjectByUrl('https://example.com/repo');
  await addProjectByPath('/repo', 'release');
  expect(bodies).toEqual([
    { url: 'https://example.com/repo', base_branch: null },
    { path: '/repo', base_branch: 'release' },
  ]);
});

test('inspection uses the typed read-only API and preserves unknown defaults and folders', async () => {
  for (const result of [
    { kind: 'repo', defaultBranch: 'dev', reason: null },
    { kind: 'repo', defaultBranch: null, reason: 'unknown_head' },
    { kind: 'folder' },
  ] satisfies components['schemas']['InspectBaseBranchResponse'][]) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/api/codebases/base-branch');
      expect(JSON.parse(String(init?.body))).toEqual({ path: '/repo' });
      return Promise.resolve(
        new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
      );
    }) as typeof fetch;
    expect(await inspectProjectBaseBranch({ path: '/repo' })).toEqual(result);
  }
});

test('rename sends the new name to the typed PATCH endpoint and returns the renamed project', async () => {
  const requests: { url: string; method: string | undefined; body: unknown }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: JSON.parse(String(init?.body)) as unknown,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ ...raw, name: 'qes' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;

  const project = await renameProject('project', 'qes');

  expect(project.name).toBe('qes');
  expect(requests).toEqual([
    { url: '/api/codebases/project', method: 'PATCH', body: { name: 'qes' } },
  ]);
});
