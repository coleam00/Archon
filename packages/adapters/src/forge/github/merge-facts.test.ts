import { describe, expect, test } from 'bun:test';
import type { ForgeRequest } from '@archon/forge/operations';
import { handleGithubOperation } from './operations';

const repo = { host: 'github.com', path: 'archon/test' };
const ref = { repo, number: 7 };
const API = 'https://api.github.com/repos/archon/test';
const GRAPHQL = 'https://api.github.com/graphql';

interface Call {
  url: string;
  query?: string;
  variables?: Record<string, unknown>;
}

/** A fake GitHub answering REST by URL and GraphQL by the query it receives. */
function fakeGitHub(answer: (call: Call) => unknown): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> })
      : undefined;
    const call: Call =
      url === GRAPHQL ? { url, query: body?.query, variables: body?.variables } : { url };
    calls.push(call);
    return Response.json(answer(call));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

async function run(request: ForgeRequest, github: { fetch: typeof fetch }) {
  return handleGithubOperation(request, { token: 'token', fetch: github.fetch });
}

const issue = (pull: boolean) => ({
  number: 7,
  repository_url: API,
  labels: [],
  html_url: `https://github.com/archon/test/${pull ? 'pull' : 'issues'}/7`,
  title: 'A title',
  body: null,
  state: 'open',
  ...(pull ? { pull_request: {} } : {}),
});
const restComment = (id: number, user: { id: number; login: string } | null) => ({
  id,
  html_url: `https://github.com/archon/test/pull/7#issuecomment-${String(id)}`,
  issue_url: `${API}/issues/7`,
  body: `comment ${String(id)}`,
  user,
});

describe('workitem.comments', () => {
  test('reads every page and projects each author, a deleted account as none', async () => {
    const github = fakeGitHub(({ url }) => {
      if (url === `${API}/issues/7`) return issue(true);
      if (url.endsWith('page=1'))
        return Array.from({ length: 100 }, (_, index) =>
          restComment(index + 1, { id: 42, login: 'maintainer' })
        );
      return [restComment(101, null)];
    });
    const response = await run(
      { operationId: 'c', op: 'workitem.comments', subject: { kind: 'pr', ref } },
      github
    );
    if (!response.ok || response.result.op !== 'workitem.comments')
      throw new Error(JSON.stringify(response));
    const { workitem, comments } = response.result.value;
    expect(workitem).toMatchObject({ kind: 'pr', ref });
    expect(comments).toHaveLength(101);
    expect(comments[0]).toEqual({
      id: '1',
      author: { host: 'github.com', id: '42', login: 'maintainer' },
      url: 'https://github.com/archon/test/pull/7#issuecomment-1',
      body: 'comment 1',
    });
    expect(comments[100]?.author).toBeNull();
  });

  test('refuses an issue asked for as a pull request before reading its comments', async () => {
    const github = fakeGitHub(() => issue(false));
    expect(
      await run({ operationId: 'c', op: 'workitem.comments', subject: { kind: 'pr', ref } }, github)
    ).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(github.calls.map(call => call.url)).toEqual([`${API}/issues/7`]);
  });
});

/** Answers the REST check reads with one green check run on any commit. */
function checkReads(url: string): unknown {
  if (url.includes('/check-runs'))
    return {
      check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }],
    };
  if (url.includes('/actions/runs')) return { total_count: 0, workflow_runs: [] };
  if (url.includes('/statuses')) return [];
  throw new Error(`Unexpected URL: ${url}`);
}

describe('checks.commit', () => {
  test('reads the checks at the default branch head it resolved', async () => {
    const github = fakeGitHub(call =>
      call.url === GRAPHQL
        ? {
            data: {
              repository: { defaultBranchRef: { name: 'main', target: { oid: 'mainsha' } } },
            },
          }
        : checkReads(call.url)
    );
    const response = await run(
      { operationId: 'k', op: 'checks.commit', repo, at: { kind: 'default_branch' } },
      github
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'checks.commit',
        value: { repo, branch: 'main', revision: 'mainsha', summary: { state: 'green' } },
      },
    });
    expect(github.calls.some(call => call.url.includes('/commits/mainsha/check-runs'))).toBe(true);
  });

  test('reads a given revision without resolving a branch', async () => {
    const github = fakeGitHub(call => checkReads(call.url));
    expect(
      await run(
        { operationId: 'k', op: 'checks.commit', repo, at: { kind: 'revision', revision: 'abc' } },
        github
      )
    ).toMatchObject({ ok: true, result: { value: { branch: null, revision: 'abc' } } });
    expect(github.calls.some(call => call.url === GRAPHQL)).toBe(false);
  });

  test('a repository with no default branch is not found', async () => {
    const github = fakeGitHub(() => ({ data: { repository: { defaultBranchRef: null } } }));
    expect(
      await run(
        { operationId: 'k', op: 'checks.commit', repo, at: { kind: 'default_branch' } },
        github
      )
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  });
});

describe('pr.merge-state', () => {
  const answer =
    (mergeable: string, mergeCommit: { oid: string } | null) =>
    (call: Call): unknown =>
      call.query?.includes('pullRequest')
        ? {
            data: {
              repository: { pullRequest: { headRefOid: 'headsha', mergeable, mergeCommit } },
            },
          }
        : {
            data: {
              repository: {
                defaultBranchRef: {
                  name: 'main',
                  target: { oid: 'mainsha' },
                  compare: { behindBy: 3 },
                },
              },
            },
          };

  test.each([
    ['MERGEABLE', 'clean'],
    ['CONFLICTING', 'conflict'],
    ['UNKNOWN', 'unknown'],
  ] as const)(
    'compares the head it read with the default branch: %s is %s',
    async (native, mergeable) => {
      const github = fakeGitHub(answer(native, null));
      expect(await run({ operationId: 'm', op: 'pr.merge-state', ref }, github)).toEqual({
        operationId: 'm',
        ok: true,
        result: {
          op: 'pr.merge-state',
          value: {
            ref,
            head_revision: 'headsha',
            default_branch: 'main',
            default_revision: 'mainsha',
            behind: 3,
            mergeable,
            merge_commit: null,
          },
        },
      });
      expect(github.calls[1]?.variables).toMatchObject({ head: 'headsha' });
    }
  );

  test('a merged pull request carries its merge commit', async () => {
    const github = fakeGitHub(answer('UNKNOWN', { oid: 'landedsha' }));
    expect(await run({ operationId: 'm', op: 'pr.merge-state', ref }, github)).toMatchObject({
      ok: true,
      result: { value: { merge_commit: 'landedsha' } },
    });
  });

  test('a GraphQL errors document is a failure, never a guessed zero', async () => {
    const github = fakeGitHub(() => ({
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest' }],
    }));
    expect(await run({ operationId: 'm', op: 'pr.merge-state', ref }, github)).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
    });
  });
});
