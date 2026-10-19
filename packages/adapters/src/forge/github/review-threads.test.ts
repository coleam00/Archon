import { describe, expect, test } from 'bun:test';
import { handleGithubOperation } from './operations';

const repo = { host: 'github.com', path: 'archon/test' };
const ref = { repo, number: 7 };
const GRAPHQL = 'https://api.github.com/graphql';
const ISSUE = 'https://api.github.com/repos/archon/test/issues/7';

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

interface Call {
  url: string;
  method: string;
  query?: string;
  variables?: Record<string, unknown>;
  body?: unknown;
}

/** A fake GitHub that answers GraphQL by the operation the query names. */
function fakeGitHub(answer: (call: Call) => unknown): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const parsed = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    const call: Call =
      url === GRAPHQL
        ? {
            url,
            method,
            query: parsed?.query as string,
            variables: parsed?.variables as Record<string, unknown>,
          }
        : { url, method, body: parsed };
    calls.push(call);
    return json(answer(call));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const comment = (id: string, body: string) => ({
  id,
  author: { login: 'reviewer', databaseId: 42 },
  body,
  url: `https://github.com/archon/test/pull/7#discussion_${id}`,
});
const thread = (id: string, comments: unknown[], more = false) => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: 'src/a.ts',
  line: 3,
  comments: {
    pageInfo: { hasNextPage: more, endCursor: more ? `${id}-c` : null },
    nodes: comments,
  },
});
const threadOwner = (number = 7, resolved = false) => ({
  data: {
    node: {
      isResolved: resolved,
      pullRequest: { number, repository: { nameWithOwner: 'archon/test' } },
    },
  },
});

describe('pr.threads', () => {
  test('reads every page of threads and of a long comment list', async () => {
    const github = fakeGitHub(call => {
      if (call.query?.includes('reviewThreads'))
        return call.variables?.after === null
          ? {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: true, endCursor: 'p1' },
                      nodes: [thread('t1', [comment('c1', 'first')], true)],
                    },
                  },
                },
              },
            }
          : {
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          ...thread('t2', [{ ...comment('c3', 'bot'), author: null }]),
                          isResolved: true,
                        },
                      ],
                    },
                  },
                },
              },
            };
      // The rest of t1's comments.
      return {
        data: {
          node: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [comment('c2', 'second')],
            },
          },
        },
      };
    });
    const response = await handleGithubOperation(
      { operationId: 'threads', op: 'pr.threads', ref },
      { token: 'token', fetch: github.fetch }
    );
    if (!response.ok || response.result.op !== 'pr.threads')
      throw new Error(JSON.stringify(response));
    const threads = response.result.value.threads;
    expect(threads.map(item => item.id)).toEqual(['t1', 't2']);
    expect(threads[0]?.comments.map(item => item.body)).toEqual(['first', 'second']);
    expect(threads[0]?.comments[0]?.author).toEqual({
      host: 'github.com',
      id: '42',
      login: 'reviewer',
    });
    expect(threads[1]).toMatchObject({ resolved: true, comments: [{ author: null }] });
    expect(github.calls.filter(call => call.query?.includes('reviewThreads'))).toHaveLength(2);
  });

  test('a GraphQL errors document is a failure, not an empty list', async () => {
    const github = fakeGitHub(() => ({
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest' }],
    }));
    expect(
      await handleGithubOperation(
        { operationId: 't', op: 'pr.threads', ref },
        { token: 'token', fetch: github.fetch }
      )
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  });
});

describe('pr.thread.reply and pr.thread.resolve', () => {
  test('a reply on this pull request is posted and read back by its body', async () => {
    const github = fakeGitHub(call =>
      call.query?.includes('addPullRequestReviewThreadReply')
        ? {
            data: {
              addPullRequestReviewThreadReply: {
                comment: {
                  id: 'c9',
                  body: call.variables?.body,
                  url: 'https://github.com/archon/test/pull/7#r9',
                },
              },
            },
          }
        : threadOwner()
    );
    expect(
      await handleGithubOperation(
        { operationId: 'r', op: 'pr.thread.reply', ref, thread: 't1', body: 'Fixed in abc.' },
        { token: 'token', fetch: github.fetch }
      )
    ).toMatchObject({
      ok: true,
      result: { value: { outcome: 'applied', changed: true, thread: 't1' } },
    });
  });

  test('a thread of another pull request is refused before any write', async () => {
    const github = fakeGitHub(() => threadOwner(8));
    for (const request of [
      { operationId: 'r', op: 'pr.thread.reply' as const, ref, thread: 't1', body: 'x' },
      { operationId: 's', op: 'pr.thread.resolve' as const, ref, thread: 't1' },
    ]) {
      expect(
        await handleGithubOperation(request, { token: 'token', fetch: github.fetch })
      ).toMatchObject({
        ok: false,
        error: { kind: 'invalid_request' },
        mutation: { outcome: 'refused' },
      });
    }
    expect(github.calls.some(call => call.query?.startsWith('mutation'))).toBe(false);
  });

  test('resolve writes once, reads back resolved, and leaves a resolved thread alone', async () => {
    let resolved = false;
    const github = fakeGitHub(call => {
      if (call.query?.startsWith('mutation')) {
        resolved = true;
        return { data: { resolveReviewThread: { thread: { id: 't1' } } } };
      }
      return threadOwner(7, resolved);
    });
    const request = { operationId: 's', op: 'pr.thread.resolve' as const, ref, thread: 't1' };
    expect(
      await handleGithubOperation(request, { token: 'token', fetch: github.fetch })
    ).toMatchObject({
      ok: true,
      result: { value: { changed: true, resolved: true } },
    });
    expect(
      await handleGithubOperation(request, { token: 'token', fetch: github.fetch })
    ).toMatchObject({
      ok: true,
      result: { value: { changed: false, resolved: true } },
    });
    expect(github.calls.filter(call => call.query?.startsWith('mutation'))).toHaveLength(1);
  });

  test('a write GitHub rejects with an errors document is refused, as authorization', async () => {
    const github = fakeGitHub(call =>
      call.query?.startsWith('mutation')
        ? { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }
        : threadOwner()
    );
    for (const request of [
      { operationId: 'r', op: 'pr.thread.reply' as const, ref, thread: 't1', body: 'x' },
      { operationId: 's', op: 'pr.thread.resolve' as const, ref, thread: 't1' },
    ]) {
      expect(
        await handleGithubOperation(request, { token: 'token', fetch: github.fetch })
      ).toMatchObject({
        ok: false,
        error: { kind: 'authorization' },
        mutation: { outcome: 'refused' },
      });
    }
  });

  test('an id that names another kind of node is refused as not a review thread', async () => {
    const github = fakeGitHub(() => ({ data: { node: {} } }));
    expect(
      await handleGithubOperation(
        { operationId: 's', op: 'pr.thread.resolve', ref, thread: 'PR_kw' },
        { token: 'token', fetch: github.fetch }
      )
    ).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request', message: expect.stringContaining('not a review thread') },
      mutation: { outcome: 'refused' },
    });
  });

  test('a resolve that does not read back resolved is a verification failure', async () => {
    const github = fakeGitHub(call =>
      call.query?.startsWith('mutation')
        ? { data: { resolveReviewThread: { thread: { id: 't1' } } } }
        : threadOwner()
    );
    expect(
      await handleGithubOperation(
        { operationId: 's', op: 'pr.thread.resolve', ref, thread: 't1' },
        { token: 'token', fetch: github.fetch }
      )
    ).toMatchObject({ ok: false, mutation: { outcome: 'verification_failed' } });
  });
});

describe('workitem.edit-body', () => {
  const issue = (body: string, pullRequest = false) => ({
    number: 7,
    repository_url: 'https://api.github.com/repos/archon/test',
    labels: [],
    html_url: 'https://github.com/archon/test/issues/7',
    title: 'An issue',
    body,
    state: 'open',
    ...(pullRequest ? { pull_request: {} } : {}),
  });

  test('replaces the body and reads it back', async () => {
    let body = 'The contract.';
    const github = fakeGitHub(call => {
      if (call.method === 'PATCH') body = (call.body as { body: string }).body;
      return issue(body);
    });
    expect(
      await handleGithubOperation(
        { operationId: 'e', op: 'workitem.edit-body', ref, body: 'The contract.\n\n## Ruling' },
        { token: 'token', fetch: github.fetch }
      )
    ).toMatchObject({
      ok: true,
      result: { value: { changed: true, workitem: { kind: 'issue' } } },
    });
    expect(github.calls.filter(call => call.method === 'PATCH' && call.url === ISSUE)).toHaveLength(
      1
    );
  });

  test('an unchanged body writes nothing, and a pull request is refused', async () => {
    const same = fakeGitHub(() => issue('same'));
    expect(
      await handleGithubOperation(
        { operationId: 'e', op: 'workitem.edit-body', ref, body: 'same' },
        { token: 'token', fetch: same.fetch }
      )
    ).toMatchObject({ ok: true, result: { value: { changed: false } } });
    expect(same.calls.some(call => call.method === 'PATCH')).toBe(false);
    const pr = fakeGitHub(() => issue('x', true));
    expect(
      await handleGithubOperation(
        { operationId: 'e', op: 'workitem.edit-body', ref, body: 'y' },
        { token: 'token', fetch: pr.fetch }
      )
    ).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
      mutation: { outcome: 'refused' },
    });
  });
});
