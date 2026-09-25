import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { ForgeRequest } from '@archon/forge/operations';
import { githubPluginMetadata, handleGithubOperation } from './operations';

const checksRequest = {
  operationId: 'operation-1',
  op: 'checks.state',
  ref: { repo: { host: 'github.com', path: 'archon/test' }, number: 42 },
} satisfies ForgeRequest;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe('GitHub outbound producer', () => {
  test('publishes bounded metadata without naming the child credential', () => {
    expect(githubPluginMetadata).toEqual({
      protocol: 1,
      name: 'github',
      version: '1',
      forge: 'github',
      hosts: ['github.com'],
      capabilities: [
        'resolve',
        'checks.state',
        'workitem.view',
        'pr.view',
        'pr.create',
        'pr.edit-body',
        'pr.ready',
        'comment.upsert',
      ],
      token_env: ['GH_TOKEN', 'GITHUB_TOKEN'],
    });
  });

  test.each([
    ['https URL', 'https://github.com/Archon/Repo.git', 'github.com', 'Archon/Repo'],
    [
      'SSH URL',
      'ssh://git@github.example.test/Archon/Repo.git',
      'github.example.test',
      'Archon/Repo',
    ],
    ['SCP-like SSH', 'git@github.com:Archon/Repo.git', 'github.com', 'Archon/Repo'],
  ])('resolves an explicit %s remote', async (_label, remote, host, path) => {
    const response = await handleGithubOperation(
      { operationId: 'resolve-1', op: 'resolve', remote },
      { token: undefined }
    );
    expect(response).toMatchObject({
      ok: true,
      result: { op: 'resolve', value: { kind: 'resolved', repo: { host, path } } },
    });
  });

  test('rejects credential-bearing HTTP remotes and treats unsupported remotes as none', async () => {
    expect(
      await handleGithubOperation(
        { operationId: 'resolve-1', op: 'resolve', remote: 'https://secret@github.com/a/b.git' },
        { token: undefined }
      )
    ).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(
      await handleGithubOperation(
        { operationId: 'resolve-2', op: 'resolve', remote: '/workspace/local-repository' },
        { token: undefined }
      )
    ).toEqual({
      operationId: 'resolve-2',
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
  });

  test('reads the qualified PR head and preserves check identities and latest statuses', async () => {
    const urls: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/pulls/42')) return json({ head: { sha: 'exact-head-revision' } });
      if (url.includes('/check-runs')) {
        return json({
          check_runs: [
            { id: 10, name: 'build', status: 'completed', conclusion: 'success' },
            { id: 11, name: 'build', status: 'completed', conclusion: 'failure' },
            { id: 12, name: 'deploy', status: 'completed', conclusion: 'action_required' },
            { id: 13, name: 'future', status: 'mysterious', conclusion: 'new_result' },
          ],
        });
      }
      if (url.includes('/statuses')) {
        return json([
          { id: 22, context: 'security', state: 'success' },
          { id: 21, context: 'SECURITY', state: 'failure' },
          { id: 23, context: 'external-ci', state: 'pending' },
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const response = await handleGithubOperation(checksRequest, { token: 'token', fetch });
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'checks.state',
        value: {
          ref: checksRequest.ref,
          revision: 'exact-head-revision',
          required: null,
          summary: {
            state: 'red',
            counts: { total: 6, green: 2, red: 1, pending: 1, gated: 1, unknown: 1 },
          },
        },
      },
    });
    if (!response.ok || response.result.op !== 'checks.state') throw new Error('expected checks');
    expect(
      response.result.value.units.map(unit => [unit.unit.kind, unit.unit.id, unit.unit.name])
    ).toEqual([
      ['check', '10', 'build'],
      ['check', '11', 'build'],
      ['check', '12', 'deploy'],
      ['check', '13', 'future'],
      ['commit_status', '22', 'security'],
      ['commit_status', '23', 'external-ci'],
    ]);
    expect(urls).toContain(
      'https://api.github.com/repos/archon/test/commits/exact-head-revision/check-runs?filter=latest&per_page=100&page=1'
    );
  });

  test('paginates statuses and uses the enterprise API root from the qualified host', async () => {
    const seen: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      context: `context-${String(index)}`,
      state: 'success',
    }));
    const fetch = async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith('/pulls/7')) return json({ head: { sha: 'abc123' } });
      if (url.includes('/check-runs')) return json({ check_runs: [] });
      if (url.endsWith('page=1')) return json(firstPage);
      if (url.endsWith('page=2')) return json([{ id: 101, context: 'last', state: 'success' }]);
      throw new Error(`Unexpected URL: ${url}`);
    };
    const response = await handleGithubOperation(
      {
        operationId: 'enterprise',
        op: 'checks.state',
        ref: { repo: { host: 'github.example.test', path: 'owner/repo' }, number: 7 },
      },
      { token: 'token', fetch }
    );
    expect(response).toMatchObject({
      ok: true,
      result: { value: { summary: { counts: { total: 101 } } } },
    });
    expect(seen.every(url => url.startsWith('https://github.example.test/api/v3/'))).toBe(true);
    expect(seen.some(url => url.includes('/statuses?per_page=100&page=2'))).toBe(true);
  });

  test('keeps missing credentials and API failures structured', async () => {
    expect(await handleGithubOperation(checksRequest, { token: undefined })).toMatchObject({
      ok: false,
      error: { kind: 'no_credential' },
    });
    expect(
      await handleGithubOperation(checksRequest, {
        token: 'token',
        fetch: async () => json({ message: 'gone' }, 404),
      })
    ).toMatchObject({ ok: false, error: { kind: 'not_found', status: 404 } });
  });
});

describe('GitHub executable protocol', () => {
  const executable = resolve(import.meta.dir, 'plugin.ts');

  async function run(args: string[], stdin = '', token?: string) {
    const child = Bun.spawn([process.execPath, executable, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: token === undefined ? {} : { ARCHON_FORGE_TOKEN: token },
    });
    child.stdin.write(stdin);
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }

  test('prints metadata through the actual executable', async () => {
    const result = await run(['metadata']);
    expect(result).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(githubPluginMetadata)}\n`,
      stderr: '',
    });
  });

  test('returns a structured exit-one error for malformed input', async () => {
    const result = await run(['op', 'checks.state'], '{');
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      operationId: 'invalid',
      ok: false,
      error: { kind: 'invalid_request', message: 'stdin must contain one UTF-8 JSON request' },
    });
    expect(result.stderr).toBe('');
  });

  test('runs resolve through the actual executable without ambient authentication', async () => {
    const request = {
      operationId: 'resolve-exec',
      op: 'resolve',
      remote: 'git@github.com:owner/repo.git',
    };
    const result = await run(['op', 'resolve'], JSON.stringify(request));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      operationId: 'resolve-exec',
      ok: true,
      result: { op: 'resolve', value: { repo: { host: 'github.com', path: 'owner/repo' } } },
    });
  });
});

test('passes the public read conformance kit for an external-status-only repository', async () => {
  const { runForgeReadConformance } = await import('@archon/forge/conformance');
  const ref = { repo: { host: 'github.com', path: 'owner/repo' }, number: 1 };
  const failures = await runForgeReadConformance(
    request =>
      handleGithubOperation(request, {
        token: 'fixture',
        fetch: async input => {
          const url = String(input);
          if (url.includes('/pulls/')) return json({ head: { sha: 'fixture-revision' } });
          if (url.includes('/check-runs')) return json({ check_runs: [] });
          return json([{ id: 55, context: 'external/status', state: 'success' }]);
        },
      }),
    [
      {
        name: 'external CI',
        request: { operationId: 'conformance', op: 'checks.state', ref },
        expected: {
          revision: 'fixture-revision',
          state: 'green',
          units: [{ kind: 'commit_status', id: '55' }],
        },
      },
    ]
  );
  expect(failures).toEqual([]);
});
