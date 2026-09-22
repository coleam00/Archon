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
        'pr.merge',
      ],
      operations: {
        'pr.merge': {
          methods: ['merge', 'squash', 'rebase'],
          atomicConditions: ['head'],
          readback: ['commit', 'tree', 'parents'],
        },
      },
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

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    node_id: 'PR_node',
    html_url: 'https://github.com/owner/repo/pull/42',
    title: 'Title',
    body: 'old body',
    state: 'open',
    draft: false,
    merged: false,
    maintainer_can_modify: true,
    head: { ref: 'feature', sha: 'head-sha', repo: { full_name: 'owner/repo' } },
    base: { ref: 'dev', sha: 'base-sha' },
    ...overrides,
  };
}

describe('GitHub lifecycle operations', () => {
  const ref = { repo: { host: 'github.com', path: 'owner/repo' }, number: 42 };

  test('refuses unsupported merge conditions before any HTTP request', async () => {
    let calls = 0;
    const response = await handleGithubOperation(
      {
        operationId: 'merge',
        op: 'pr.merge',
        ref,
        method: 'squash',
        required: { base: 'base-sha' },
      },
      {
        token: 'token',
        fetch: async () => {
          calls++;
          return json({});
        },
      }
    );
    expect(calls).toBe(0);
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'unsupported_condition' },
      mutation: {
        op: 'pr.merge',
        outcome: 'refused',
        target: ref,
        requested: { base: 'base-sha' },
        enforced: {},
      },
    });
  });

  test('updates a PR body and verifies the read-back', async () => {
    let body = 'old body';
    const methods: string[] = [];
    const response = await handleGithubOperation(
      { operationId: 'body', op: 'pr.edit-body', ref, body: 'new body' },
      {
        token: 'token',
        fetch: async (_input, init) => {
          methods.push(init?.method ?? 'GET');
          if (init?.method === 'PATCH') body = JSON.parse(String(init.body)).body;
          return json(pull({ body }));
        },
      }
    );
    expect(methods).toEqual(['GET', 'PATCH', 'GET']);
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'pr.edit-body',
        value: { outcome: 'applied', changed: true, pr: { repo: ref.repo, number: 42 } },
      },
    });
  });

  test('passes the expected head to merge and reports landed object facts', async () => {
    let mergeBody: unknown;
    const response = await handleGithubOperation(
      {
        operationId: 'merge',
        op: 'pr.merge',
        ref,
        method: 'rebase',
        required: { head: 'head-sha' },
      },
      {
        token: 'token',
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith('/pulls/42/merge')) {
            mergeBody = JSON.parse(String(init?.body));
            return json({ merged: true, sha: 'landed' });
          }
          if (url.endsWith('/pulls/42')) return json(pull({ state: 'closed', merged: true }));
          if (url.endsWith('/git/commits/landed'))
            return json({ sha: 'landed', tree: { sha: 'tree' }, parents: [{ sha: 'parent' }] });
          throw new Error(`Unexpected URL: ${url}`);
        },
      }
    );
    expect(mergeBody).toEqual({ merge_method: 'rebase', sha: 'head-sha' });
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          outcome: 'applied',
          enforced: { head: 'head-sha' },
          method: 'rebase',
          landed: {
            commit: { available: true, value: 'landed' },
            tree: { available: true, value: 'tree' },
            parents: { available: true, value: ['parent'] },
          },
        },
      },
    });
  });

  test('keeps a lost write response as outcome unknown', async () => {
    let calls = 0;
    const response = await handleGithubOperation(
      { operationId: 'body', op: 'pr.edit-body', ref, body: 'new body' },
      {
        token: 'token',
        fetch: async (_input, init) => {
          calls++;
          if (init?.method === 'PATCH') throw new Error('connection lost');
          return json(pull());
        },
      }
    );
    expect(calls).toBe(2);
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'outcome_unknown', target: ref },
    });
  });

  test('keeps a server error after submission as outcome unknown', async () => {
    const response = await handleGithubOperation(
      { operationId: 'body-500', op: 'pr.edit-body', ref, body: 'new body' },
      {
        token: 'token',
        fetch: async (_input, init) =>
          init?.method === 'PATCH' ? json({ message: 'failed' }, 500) : json(pull()),
      }
    );
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'outcome_unknown', target: ref },
    });
  });

  test('does not claim expected-head enforcement when the merge response is lost', async () => {
    const response = await handleGithubOperation(
      {
        operationId: 'merge-lost',
        op: 'pr.merge',
        ref,
        method: 'merge',
        required: { head: 'head-sha' },
      },
      { token: 'token', fetch: async () => Promise.reject(new Error('connection lost')) }
    );
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'outcome_unknown', requested: { head: 'head-sha' }, enforced: {} },
    });
  });

  test('reports malformed acknowledged REST writes as verification failures', async () => {
    const request = {
      operationId: 'create',
      op: 'pr.create' as const,
      repo: ref.repo,
      headRepo: ref.repo,
      head: 'feature',
      headRevision: 'head-sha',
      base: 'dev',
      title: 'Title',
      body: 'Body',
      draft: true,
    };
    const response = await handleGithubOperation(request, {
      token: 'token',
      fetch: async () => json({ malformed: true }, 201),
    });
    expect(response).toMatchObject({
      ok: false,
      mutation: { op: 'pr.create', outcome: 'verification_failed', target: ref.repo },
    });
  });

  test('includes head_repo when creating from a same-organization fork', async () => {
    const repo = { host: 'github.com', path: 'org/base' };
    const headRepo = { host: 'github.com', path: 'org/fork' };
    let postBody: Record<string, unknown> | undefined;
    const response = await handleGithubOperation(
      {
        operationId: 'create-fork',
        op: 'pr.create',
        repo,
        headRepo,
        head: 'feature',
        headRevision: 'head-sha',
        base: 'dev',
        title: 'Title',
        body: 'Body',
        draft: true,
      },
      {
        token: 'token',
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith('/repos/org/fork')) return json({ full_name: 'org/fork' });
          if (init?.method === 'POST') {
            postBody = JSON.parse(String(init.body));
            return json(
              pull({
                body: 'Body',
                draft: true,
                head: { ref: 'feature', sha: 'head-sha', repo: { full_name: 'org/fork' } },
                base: { ref: 'dev', sha: 'base-sha' },
              }),
              201
            );
          }
          return json(
            pull({
              body: 'Body',
              draft: true,
              head: { ref: 'feature', sha: 'head-sha', repo: { full_name: 'org/fork' } },
              base: { ref: 'dev', sha: 'base-sha' },
            })
          );
        },
      }
    );
    expect(postBody).toMatchObject({ head: 'org:feature', head_repo: 'fork' });
    expect(response).toMatchObject({
      ok: true,
      result: { value: { pr: { head_repo: headRepo } } },
    });
  });

  test('treats invalid JSON after a successful REST write as acknowledged', async () => {
    const response = await handleGithubOperation(
      { operationId: 'body-json', op: 'pr.edit-body', ref, body: 'new body' },
      {
        token: 'token',
        fetch: async (_input, init) =>
          init?.method === 'PATCH' ? new Response('not json', { status: 200 }) : json(pull()),
      }
    );
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'verification_failed', target: ref },
    });
  });

  test('refuses merged ready requests with the observed record', async () => {
    let calls = 0;
    const response = await handleGithubOperation(
      { operationId: 'ready', op: 'pr.ready', ref },
      {
        token: 'token',
        fetch: async () => {
          calls++;
          return json(pull({ state: 'closed', merged: true }));
        },
      }
    );
    expect(calls).toBe(1);
    expect(response).toMatchObject({
      ok: false,
      mutation: { outcome: 'refused', observed: { state: 'merged' } },
    });
  });

  test('does not treat GraphQL errors as ready acknowledgement', async () => {
    let calls = 0;
    const response = await handleGithubOperation(
      { operationId: 'ready', op: 'pr.ready', ref },
      {
        token: 'token',
        fetch: async (_input, init) => {
          calls++;
          return init?.method === 'POST'
            ? json({ data: { markPullRequestReadyForReview: null }, errors: [{ message: 'no' }] })
            : json(pull({ draft: true }));
        },
      }
    );
    expect(calls).toBe(2);
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'outcome_unknown' } });
  });

  test('matches comment markers only on the exact first line and verifies target identity', async () => {
    const marker = '<!-- canonical -->';
    const issueUrl = 'https://api.github.com/repos/owner/repo/issues/42';
    const seenMethods: string[] = [];
    const response = await handleGithubOperation(
      { operationId: 'comment', op: 'comment.upsert', ref, marker, body: `${marker}\nnew report` },
      {
        token: 'token',
        fetch: async (input, init) => {
          seenMethods.push(init?.method ?? 'GET');
          const url = String(input);
          if (url.includes('/comments?'))
            return json([
              {
                id: 1,
                html_url: 'https://github.com/comment/1',
                issue_url: issueUrl,
                body: `> ${marker}\nquoted`,
              },
            ]);
          if (init?.method === 'POST')
            return json(
              {
                id: 2,
                html_url: 'https://github.com/comment/2',
                issue_url: issueUrl,
                body: `${marker}\nnew report`,
              },
              201
            );
          return json({
            id: 2,
            html_url: 'https://github.com/comment/2',
            issue_url: issueUrl,
            body: `${marker}\nnew report`,
          });
        },
      }
    );
    expect(seenMethods).toEqual(['GET', 'POST', 'GET']);
    expect(response).toMatchObject({ ok: true, result: { value: { comment: { id: '2', ref } } } });
  });

  test('refuses a failed no-change comment read-back without claiming a write', async () => {
    const marker = '<!-- canonical -->';
    const issueUrl = 'https://api.github.com/repos/owner/repo/issues/42';
    const response = await handleGithubOperation(
      { operationId: 'comment-read', op: 'comment.upsert', ref, marker, body: `${marker}\nreport` },
      {
        token: 'token',
        fetch: async input =>
          String(input).includes('/comments?')
            ? json([
                {
                  id: 7,
                  html_url: 'https://github.com/comment/7',
                  issue_url: issueUrl,
                  body: `${marker}\nreport`,
                },
              ])
            : Promise.reject(new Error('read failed')),
      }
    );
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'refused', enforced: {} } });
  });

  test('re-reads a head-selected PR so merged state is authoritative', async () => {
    let calls = 0;
    const response = await handleGithubOperation(
      {
        operationId: 'view-head',
        op: 'pr.view',
        selector: { kind: 'head', repo: ref.repo, headRepo: ref.repo, head: 'feature' },
      },
      {
        token: 'token',
        fetch: async input => {
          calls++;
          return String(input).includes('/pulls?')
            ? json([pull({ state: 'closed', merged: false })])
            : json(pull({ state: 'closed', merged: true }));
        },
      }
    );
    expect(calls).toBe(2);
    expect(response).toMatchObject({ ok: true, result: { value: { pr: { state: 'merged' } } } });
  });

  test('refuses a comment whose first line is not its marker before HTTP', async () => {
    let calls = 0;
    const response = await handleGithubOperation(
      {
        operationId: 'comment',
        op: 'comment.upsert',
        ref,
        marker: '<!-- canonical -->',
        body: `intro\n<!-- canonical -->`,
      },
      {
        token: 'token',
        fetch: async () => {
          calls++;
          return json({});
        },
      }
    );
    expect(calls).toBe(0);
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
  });

  test('passes the public mutation conformance runner with the actual mutator', async () => {
    const { runForgeMutationConformance } = await import('@archon/forge/conformance');
    let calls = 0;
    const request = {
      operationId: 'conformance-merge',
      op: 'pr.merge' as const,
      ref,
      method: 'merge' as const,
      required: { resultTree: 'tree' },
    };
    const failures = await runForgeMutationConformance(
      value =>
        handleGithubOperation(value, {
          token: 'token',
          fetch: async () => {
            calls++;
            return json({});
          },
        }),
      githubPluginMetadata,
      [{ name: 'unsupported result tree', request, expectedOutcome: 'refused' }]
    );
    expect(calls).toBe(0);
    expect(failures).toEqual([]);
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
