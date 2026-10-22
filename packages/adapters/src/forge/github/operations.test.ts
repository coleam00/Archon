import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { discoverPlugins } from '@archon/forge/discovery';
import { dispatchForge } from '@archon/forge/dispatch';
import { forgeRequestSchema, type ForgeRequest } from '@archon/forge/operations';
import { githubPluginMetadata, handleGithubOperation } from './operations';

const invalidRemotePaths = [
  'team',
  'team/repo/extra',
  'team/.git',
  'team/%2E%2E',
  'team/../owner/repo.git',
  'team/%2E%2E/owner/repo.git',
  'team/..git',
  'team/...git',
  'team/%2E.git',
  'team/%2E%2E.git',
  'team\\../owner/repo.git',
  'team/..\\owner/repo.git',
];

const normalizedRemotePaths = [
  ...['\t', '\n', '\r'].flatMap(control => [`te${control}am/repo.git`, `team/re${control}po.git`]),
];
const invalidHttpRemotePaths = ['team\\extra/repo.git', 'team/repo\\extra.git'];

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
        'workitem.create',
        'workitem.labels.set',
        'workitem.label.add',
        'workitem.label.remove',
        'workitem.comment.upsert',
        'workitem.close',
        'workitem.edit-body',
        'workitem.list',
        'repo.labels.list',
        'repo.label.ensure',
        'pr.view',
        'pr.create',
        'pr.edit-body',
        'pr.ready',
        'pr.draft',
        'comment.upsert',
        'pr.merge',
        'checks.rerun',
        'pr.reviews',
        'pr.threads',
        'pr.thread.reply',
        'pr.thread.resolve',
      ],
      mutationConditions: { 'pr.merge': ['head'] },
      token_env: ['GH_TOKEN', 'GITHUB_TOKEN'],
    });
  });

  test.each([
    [
      'HTTP URL',
      'http://GHES.example.test:8080/Archon/Repo.git',
      'ghes.example.test:8080',
      'Archon/Repo',
    ],
    ...[
      ['http', '80'],
      ['https', '443'],
      ['http', '443'],
      ['https', '80'],
      ['https', '8080'],
    ].map(([protocol, port]) => [
      `${protocol} port ${port}`,
      `${protocol}://GHES.example.test:${port}/Archon/Repo.git`,
      `ghes.example.test:${port}`,
      'Archon/Repo',
    ]),
    ['https URL', 'https://github.com/Archon/Repo.git', 'github.com', 'Archon/Repo'],
    [
      'SSH URL',
      'ssh://git@github.example.test/Archon/Repo.git',
      'github.example.test',
      'Archon/Repo',
    ],
    ...['http', 'https', 'ssh'].flatMap(protocol =>
      normalizedRemotePaths.map(path => [
        `${protocol} normalized path ${JSON.stringify(path)}`,
        `${protocol}://ghes.example.test:8080/${path}`,
        'ghes.example.test:8080',
        'team/repo',
      ])
    ),
    [
      'SSH backslash owner',
      'ssh://ghes.example.test:8080/team\\extra/repo.git',
      'ghes.example.test:8080',
      'team\\extra/repo',
    ],
    [
      'SSH backslash repository',
      'ssh://ghes.example.test:8080/team/repo\\extra.git',
      'ghes.example.test:8080',
      'team/repo\\extra',
    ],
    ['SCP-like SSH', 'git@github.com:Archon/Repo.git', 'github.com', 'Archon/Repo'],
  ])('resolves an explicit %s remote', async (_label, remote, host, path) => {
    const response = await handleGithubOperation(
      { operationId: 'resolve-1', op: 'resolve', remote },
      {
        token: undefined,
        fetch: async () => {
          throw new Error('Resolution must not fetch');
        },
      }
    );
    expect(response).toMatchObject({
      ok: true,
      result: { op: 'resolve', value: { kind: 'resolved', repo: { host, path } } },
    });
  });

  test.each([
    'https://secret@github.com/a/b.git',
    'http://secret@ghes.example.test:8080/a/b.git',
    'http://:secret@ghes.example.test:8080/a/b.git',
    'http://user:secret@ghes.example.test:8080/a/b.git',
    'http://ghes.example.test:8080/a/b.git?query=1',
    'http://ghes.example.test:8080/a/b.git#fragment',
    ...['http', 'https', 'ssh'].flatMap(protocol =>
      ['?', '#'].map(marker => `${protocol}://ghes.example.test:8080/a/b.git${marker}`)
    ),
  ])('rejects credentials, queries and fragments: %s', async remote => {
    expect(
      await handleGithubOperation(
        { operationId: 'resolve-invalid', op: 'resolve', remote },
        { token: undefined }
      )
    ).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });

  test.each([
    '/workspace/local-repository',
    ...['http', 'https', 'ssh'].flatMap(protocol =>
      invalidRemotePaths.map(path => `${protocol}://ghes.example.test:8080/${path}`)
    ),
    ...['http', 'https'].flatMap(protocol =>
      invalidHttpRemotePaths.map(path => `${protocol}://ghes.example.test:8080/${path}`)
    ),
    ...['http', 'https'].flatMap(protocol =>
      ['team/repo.git', 'team/extra/repo.git'].map(
        path => `${protocol}://ghes.example.test:8080\\${path}`
      )
    ),
    'git@ghes.example.test:team/..git',
    'git@ghes.example.test:team/...git',
  ])('treats invalid repository paths as none: %s', async remote => {
    expect(
      await handleGithubOperation(
        { operationId: 'resolve-invalid', op: 'resolve', remote },
        { token: undefined }
      )
    ).toEqual({
      operationId: 'resolve-invalid',
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
      if (url.includes('/actions/runs')) return json({ total_count: 0, workflow_runs: [] });
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
      if (url.includes('/actions/runs')) return json({ total_count: 0, workflow_runs: [] });
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
          if (url.includes('/actions/runs')) return json({ total_count: 0, workflow_runs: [] });
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

test.each([
  ['action_required', 'head', true],
  ['action_required', 'old-head', false],
  [null, 'head', false],
  ['success', 'head', false],
] as const)(
  'approval evidence uses explicit workflow conclusions at the current head: %s %s',
  async (conclusion, head, approvalPending) => {
    const response = await handleGithubOperation(checksRequest, {
      token: 'token',
      fetch: async input => {
        const url = String(input);
        if (url.includes('/pulls/')) return json({ head: { sha: 'head' } });
        if (url.includes('/actions/runs'))
          return json({
            total_count: 1,
            workflow_runs: [
              {
                id: 100,
                head_sha: head,
                check_suite_id: 10,
                run_attempt: 1,
                status: conclusion === null ? 'waiting' : 'completed',
                conclusion,
              },
            ],
          });
        if (url.includes('/check-runs')) return json({ check_runs: [] });
        return json([]);
      },
    });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { approvalPending, units: [], summary: { state: 'none' } } },
    });
  }
);

test('failed or truncated Actions enumeration cannot certify absence of approval', async () => {
  for (const reply of [json({}, 403), json({ total_count: 1001, workflow_runs: [] })]) {
    const response = await handleGithubOperation(checksRequest, {
      token: 'token',
      fetch: async input => {
        const url = String(input);
        if (url.includes('/pulls/')) return json({ head: { sha: 'head' } });
        if (url.includes('/actions/runs')) return reply;
        if (url.includes('/check-runs')) return json({ check_runs: [] });
        return json([]);
      },
    });
    expect(response.ok).toBe(false);
  }
});

test('check suites resolve opaque rerun groups, preserving distinct same-name check units', async () => {
  const response = await handleGithubOperation(checksRequest, {
    token: 'token',
    fetch: async input => {
      const url = String(input);
      if (url.includes('/pulls/')) return json({ head: { sha: 'head' } });
      if (url.includes('/actions/runs'))
        return json({
          total_count: 1,
          workflow_runs: [
            {
              id: 900,
              head_sha: 'head',
              check_suite_id: 10,
              run_attempt: 3,
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        });
      if (url.includes('/check-runs'))
        return json({
          check_runs: [1, 2].map(id => ({
            id,
            name: 'same',
            head_sha: 'head',
            app: { slug: 'github-actions' },
            check_suite: { id: 10 },
            status: 'completed',
            conclusion: 'failure',
          })),
        });
      return json([{ id: 3, context: 'external', state: 'failure' }]);
    },
  });
  if (!response.ok || response.result.op !== 'checks.state') throw new Error('expected checks');
  expect(response.result.value.units.map(unit => [unit.unit.id, unit.rerun])).toEqual([
    ['1', { id: '900', attempt: 3 }],
    ['2', { id: '900', attempt: 3 }],
    ['3', null],
  ]);
});

test('workflow-run approval enumeration includes later enterprise pages', async () => {
  const seen: string[] = [];
  const response = await handleGithubOperation(
    {
      ...checksRequest,
      ref: { ...checksRequest.ref, repo: { host: 'ghe.example.test', path: 'owner/repo' } },
    },
    {
      token: 'token',
      fetch: async input => {
        const url = String(input);
        seen.push(url);
        if (url.includes('/pulls/')) return json({ head: { sha: 'head' } });
        if (url.includes('/check-runs')) return json({ check_runs: [] });
        if (url.includes('/statuses')) return json([]);
        const run = {
          id: 100,
          head_sha: 'head',
          check_suite_id: 10,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
        };
        return json({
          total_count: 101,
          workflow_runs: url.endsWith('page=1')
            ? Array.from({ length: 100 }, (_, id) => ({ ...run, id }))
            : [{ ...run, conclusion: 'action_required' }],
        });
      },
    }
  );
  expect(response).toMatchObject({
    ok: true,
    result: { value: { approvalPending: true, summary: { state: 'none' } } },
  });
  expect(seen).toContain(
    'https://ghe.example.test/api/v3/repos/owner/repo/actions/runs?head_sha=head&per_page=100&page=2'
  );
});

test('empty-response mode is explicit and never disables existing JSON validation', async () => {
  const { githubRequest } = await import('./api');
  const fetch = async () => new Response(null, { status: 201 });
  await expect(githubRequest(fetch, 'token', 'https://api.github.com/test')).rejects.toThrow(
    'invalid JSON'
  );
  expect(
    await githubRequest(fetch, 'token', 'https://api.github.com/test', {}, undefined, 'empty')
  ).toBeUndefined();
});

describe('GitHub forge origins', () => {
  test.each([
    [
      'http://GHES.example.test:8080/',
      'ghes.example.test:8080',
      'http://ghes.example.test:8080/api/v3',
      'http://ghes.example.test:8080/api/graphql',
    ],
    [
      'http://ghes.example.test:80',
      'ghes.example.test:80',
      'http://ghes.example.test/api/v3',
      'http://ghes.example.test/api/graphql',
    ],
    [
      'http://ghes.example.test:8080',
      'ghes.example.test:08080',
      'http://ghes.example.test:8080/api/v3',
      'http://ghes.example.test:8080/api/graphql',
    ],
    [
      'http://ghes.example.test:80',
      'ghes.example.test',
      'http://ghes.example.test/api/v3',
      'http://ghes.example.test/api/graphql',
    ],
    [
      'https://ghes.example.test:443',
      'ghes.example.test:443',
      'https://ghes.example.test/api/v3',
      'https://ghes.example.test/api/graphql',
    ],
    [
      'http://ghes.example.test:8080',
      'GHES.EXAMPLE.TEST:8080',
      'http://ghes.example.test:8080/api/v3',
      'http://ghes.example.test:8080/api/graphql',
    ],
    [
      'https://ghes.example.test:8443',
      'ghes.example.test:8443',
      'https://ghes.example.test:8443/api/v3',
      'https://ghes.example.test:8443/api/graphql',
    ],
    [
      'http://ghes.example.test:443',
      'ghes.example.test:443',
      'http://ghes.example.test:443/api/v3',
      'http://ghes.example.test:443/api/graphql',
    ],
    [
      'http://github.com:8080',
      'github.com',
      'https://api.github.com',
      'https://api.github.com/graphql',
    ],
    [
      'http://other.example.test:8080',
      'ghes.example.test:8080',
      'https://ghes.example.test:8080/api/v3',
      'https://ghes.example.test:8080/api/graphql',
    ],
    [
      'http://ghes.example.test:8080',
      'ghes.example.test:8443',
      'https://ghes.example.test:8443/api/v3',
      'https://ghes.example.test:8443/api/graphql',
    ],
    [
      '',
      'ghes.example.test',
      'https://ghes.example.test/api/v3',
      'https://ghes.example.test/api/graphql',
    ],
    [
      'http://ghes.example.test:8080',
      'github.com',
      'https://api.github.com',
      'https://api.github.com/graphql',
    ],
  ])('routes REST and GraphQL with GITHUB_URL=%s for %s', async (origin, host, rest, graphql) => {
    const previous = process.env.GITHUB_URL;
    process.env.GITHUB_URL = origin;
    try {
      const repo = { host, path: 'owner/repo' };
      const calls: { url: string; authorization: string | null }[] = [];
      const fetch = async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return Response.json(
          init?.method === 'POST'
            ? {
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [],
                      },
                    },
                  },
                },
              }
            : []
        );
      };
      expect(
        await handleGithubOperation(
          { operationId: 'labels', op: 'repo.labels.list', repo },
          { token: 'selected-token', fetch }
        )
      ).toMatchObject({ ok: true });
      expect(
        await handleGithubOperation(
          { operationId: 'threads', op: 'pr.threads', ref: { repo, number: 1 } },
          { token: 'selected-token', fetch }
        )
      ).toMatchObject({ ok: true });
      expect(calls).toEqual([
        {
          url: `${rest}/repos/owner/repo/labels?per_page=100&page=1`,
          authorization: 'Bearer selected-token',
        },
        { url: graphql, authorization: 'Bearer selected-token' },
      ]);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_URL;
      else process.env.GITHUB_URL = previous;
    }
  });

  test.each(['owner/../repo', 'owner/.git', 'owner/..git', 'owner/...git'])(
    'invalid repository path %s fails before any repository operation fetches',
    async path => {
      let calls = 0;
      const fetch = async () => {
        calls++;
        throw new Error('Invalid repository must not fetch');
      };
      const repo = { host: 'ghes.example.test:8080', path };
      const ref = { repo, number: 1 };
      const subject = { kind: 'issue', ref } as const;
      const operationId = 'invalid-path';
      const revision = 'a'.repeat(40);
      const requests = [
        ...(
          [
            'checks.state',
            'pr.reviews',
            'pr.threads',
            'pr.ready',
            'pr.draft',
            'workitem.view',
          ] as const
        ).map(op => ({ operationId, op, ref })),
        { operationId, op: 'repo.labels.list', repo },
        { operationId, op: 'workitem.list', repo, label: 'queued' },
        {
          operationId,
          op: 'workitem.create',
          repo,
          title: 'title',
          marker: 'marker',
          body: 'marker',
        },
        { operationId, op: 'workitem.labels.set', ref, labels: [] },
        { operationId, op: 'workitem.close', ref, reason: 'completed' },
        ...(['workitem.label.add', 'workitem.label.remove'] as const).map(op => ({
          operationId,
          op,
          subject,
          name: 'queued',
        })),
        {
          operationId,
          op: 'workitem.comment.upsert',
          subject,
          marker: 'marker',
          body: 'marker\nbody',
        },
        {
          operationId,
          op: 'repo.label.ensure',
          repo,
          name: 'queued',
          color: 'abcdef',
          description: '',
        },
        { operationId, op: 'comment.upsert', ref, marker: 'marker', body: 'marker\nbody' },
        ...(['pr.edit-body', 'workitem.edit-body'] as const).map(op => ({
          operationId,
          op,
          ref,
          body: 'body',
        })),
        { operationId, op: 'pr.merge', ref, method: 'squash', conditions: { head: revision } },
        {
          operationId,
          op: 'checks.rerun',
          ref,
          revision,
          units: [
            { unit: { kind: 'check', id: '1', name: 'test' }, rerun: { id: '2', attempt: 1 } },
          ],
        },
        { operationId, op: 'pr.thread.reply', ref, thread: 'thread', body: 'body' },
        { operationId, op: 'pr.thread.resolve', ref, thread: 'thread' },
        { operationId, op: 'pr.view', selector: { kind: 'number', ref } },
        ...[repo, { ...repo, path: 'valid/repo' }].flatMap(
          base =>
            [
              {
                operationId,
                op: 'pr.view',
                selector: { kind: 'head', repo: base, headRepo: repo, head: 'feature' },
              },
              {
                operationId,
                op: 'pr.create',
                repo: base,
                headRepo: repo,
                head: 'feature',
                headRevision: revision,
                base: 'dev',
                title: 'title',
                body: '',
                draft: false,
              },
            ] satisfies ForgeRequest[]
        ),
      ] satisfies ForgeRequest[];
      for (const request of requests) {
        const response = await handleGithubOperation(forgeRequestSchema.parse(request), {
          token: 'selected-token',
          fetch,
        });
        expect(response).toMatchObject({
          ok: false,
          error: { kind: 'invalid_request', message: expect.stringContaining('repository path') },
        });
      }
      expect(calls).toBe(0);
    }
  );
});

test('invalid configured GitHub origins fail before sending a credential', async () => {
  const previous = process.env.GITHUB_URL;
  process.env.GITHUB_URL = 'http://user:private@ghes.example.test:8080';
  try {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return Response.json({});
    };
    const repo = { host: 'ghes.example.test:8080', path: 'owner/repo' };
    for (const request of [
      { operationId: 'labels', op: 'repo.labels.list', repo },
      { operationId: 'threads', op: 'pr.threads', ref: { repo, number: 1 } },
      {
        operationId: 'create',
        op: 'repo.label.ensure',
        repo,
        name: 'queued',
        color: 'abcdef',
        description: '',
      },
    ] satisfies ForgeRequest[]) {
      const response = await handleGithubOperation(request, { token: 'selected-token', fetch });
      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('GITHUB_URL') },
      });
      expect(JSON.stringify(response)).not.toContain('private');
    }
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_URL;
    else process.env.GITHUB_URL = previous;
  }
});

test('dispatch resolves only claimed GitHub remotes and preserves parser validation', async () => {
  const host = 'ghes.example.test:8080';
  const discovery = await discoverPlugins({
    config: {
      plugins: [
        {
          plugin: 'github',
          command: process.execPath,
          args: [resolve(import.meta.dir, 'plugin.ts')],
        },
      ],
      hosts: {
        [host]: 'github',
        'ghes.example.test:80': 'github',
        'ghes.example.test:443': 'github',
      },
      scanPath: false,
    },
    env: {},
  });
  for (const [remote, expectedHost] of [
    [`http://GHES.example.test:8080/team/repo.git`, host],
    [`https://${host}/team/repo.git`, host],
    [`ssh://git@${host}/team/repo.git`, host],
    ['git@github.com:team/repo.git', 'github.com'],
    ...['http', 'https', 'ssh'].flatMap(protocol =>
      normalizedRemotePaths.map(path => [`${protocol}://${host}/${path}`, host])
    ),
    ...['http', 'https'].flatMap(protocol =>
      ['80', '443', '8080'].map(port => [
        `${protocol}://ghes.example.test:${port}/team/repo.git`,
        `ghes.example.test:${port}`,
      ])
    ),
  ]) {
    const result = await dispatchForge(
      { operationId: 'resolve-dispatch', op: 'resolve', remote },
      { discovery, env: {} }
    );
    expect(result.response).toMatchObject({
      ok: true,
      result: {
        op: 'resolve',
        value: {
          kind: 'resolved',
          forge: 'github',
          repo: { host: expectedHost, path: 'team/repo' },
        },
      },
    });
    expect(result.plugin).toEqual({ name: 'github', version: '1' });
  }
  for (const remote of [
    'http://unclaimed.example.test:8080/team/repo.git',
    'http://ghes.example.test/team/repo.git',
    'http://ghes.example.test:9090/team/repo.git',
  ]) {
    const unclaimed = await dispatchForge(
      { operationId: 'unclaimed', op: 'resolve', remote },
      { discovery, env: {} }
    );
    expect(unclaimed.plugin).toBeNull();
    expect(unclaimed.response).toMatchObject({
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
  }
  for (const remote of [
    `http://user@${host}/team/repo.git`,
    `http://:password@${host}/team/repo.git`,
    `http://user:password@${host}/team/repo.git`,
    `http://${host}/team/repo.git?query=1`,
    `http://${host}/team/repo.git#fragment`,
    ...['http', 'https', 'ssh'].flatMap(protocol =>
      ['?', '#'].map(marker => `${protocol}://${host}/team/repo.git${marker}`)
    ),
  ]) {
    const result = await dispatchForge(
      { operationId: 'invalid', op: 'resolve', remote },
      { discovery, env: {} }
    );
    expect(result.response).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  }
  for (const remote of [
    ...invalidRemotePaths.map(path => `http://${host}/${path}`),
    ...['http', 'https'].flatMap(protocol =>
      invalidHttpRemotePaths.map(path => `${protocol}://${host}/${path}`)
    ),
    ...['http', 'https'].flatMap(protocol =>
      ['team/repo.git', 'team/extra/repo.git'].map(path => `${protocol}://${host}\\${path}`)
    ),
  ]) {
    const result = await dispatchForge(
      { operationId: 'invalid-path', op: 'resolve', remote },
      { discovery, env: {} }
    );
    expect(result.response).toMatchObject({
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
  }
});
