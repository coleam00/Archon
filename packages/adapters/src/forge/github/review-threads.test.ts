import { describe, expect, test } from 'bun:test';
import { forgeResponseSchema } from '@archon/forge/operations';
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

const comment = (
  id: string,
  body: string,
  createdAt = '2026-11-11T10:00:00Z',
  author: unknown = { __typename: 'User', login: 'reviewer', id: 'U_reviewer', databaseId: 42 }
) => ({
  id,
  author,
  createdAt,
  originalCommit: { oid: `${id}-commit` },
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
      type: 'user',
    });
    expect(threads[1]).toMatchObject({ resolved: true, comments: [{ author: null }] });
    expect(github.calls.filter(call => call.query?.includes('reviewThreads'))).toHaveLength(2);
  });

  test('each comment author carries its GraphQL account type, a missing one as null', async () => {
    const github = fakeGitHub(() => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                thread('t1', [
                  comment('c1', 'a', undefined, {
                    __typename: 'User',
                    login: 'dev',
                    id: 'U_dev',
                    databaseId: 1,
                  }),
                  comment('c2', 'b', undefined, {
                    __typename: 'Bot',
                    login: 'ci',
                    id: 'BOT_ci',
                    databaseId: 2,
                  }),
                  comment('c3', 'c', undefined, {
                    __typename: 'Organization',
                    login: 'acme',
                    id: 'O_acme',
                    databaseId: 3,
                  }),
                  comment('c4', 'd', undefined, {
                    login: 'untyped',
                    id: 'X_untyped',
                    databaseId: 4,
                  }),
                  comment('c5', 'e', undefined, {
                    __typename: 'Mannequin',
                    login: 'm',
                    id: 'MQ_m',
                    databaseId: 5,
                  }),
                ]),
              ],
            },
          },
        },
      },
    }));
    const response = await handleGithubOperation(
      { operationId: 'threads', op: 'pr.threads', ref },
      { token: 'token', fetch: github.fetch }
    );
    if (!response.ok || response.result.op !== 'pr.threads')
      throw new Error(JSON.stringify(response));
    const authors = response.result.value.threads[0]?.comments.map(item => item.author);
    expect(authors?.map(item => item?.type)).toEqual(['user', 'bot', 'organization', null, null]);
    expect(authors?.[1]).toEqual({ host: 'github.com', id: '2', login: 'ci', type: 'bot' });
    expect(forgeResponseSchema.safeParse(response).success).toBe(true);
    expect(github.calls[0]?.query).toContain('author{__typename login');
  });

  test('an organization or mannequin author keeps the numeric id REST gives the account', async () => {
    const github = fakeGitHub(() => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                thread('t1', [
                  comment('c1', 'a', undefined, {
                    __typename: 'Organization',
                    login: 'acme',
                    id: 'O_acme',
                    databaseId: 9001,
                  }),
                  comment('c2', 'b', undefined, {
                    __typename: 'Mannequin',
                    login: 'imported',
                    id: 'MDk6TWFubmVxdWlu',
                    databaseId: 9002,
                  }),
                  comment('c3', 'c', undefined, {
                    __typename: 'EnterpriseUserAccount',
                    login: 'ent',
                    id: 'MDIxOkVudGVycHJpc2VVc2VyQWNjb3VudDE=',
                  }),
                ]),
              ],
            },
          },
        },
      },
    }));
    const response = await handleGithubOperation(
      { operationId: 'threads', op: 'pr.threads', ref },
      { token: 'token', fetch: github.fetch }
    );
    if (!response.ok || response.result.op !== 'pr.threads')
      throw new Error(JSON.stringify(response));
    expect(response.result.value.threads[0]?.comments.map(item => item.author)).toEqual([
      { host: 'github.com', id: '9001', login: 'acme', type: 'organization' },
      { host: 'github.com', id: '9002', login: 'imported', type: null },
      // GitHub gives an enterprise user account no numeric id; its node id stands in.
      { host: 'github.com', id: 'MDIxOkVudGVycHJpc2VVc2VyQWNjb3VudDE=', login: 'ent', type: null },
    ]);
    for (const kind of ['Organization', 'Mannequin'])
      expect(github.calls[0]?.query).toContain(`... on ${kind}{databaseId}`);
  });

  test('every thread and comment carries when it was created and on which commit', async () => {
    const github = fakeGitHub(() => ({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                thread('t1', [
                  comment('c1', 'before', '2026-11-11T09:00:00Z'),
                  { ...comment('c2', 'after', '2026-11-11T11:00:00Z'), originalCommit: null },
                ]),
              ],
            },
          },
        },
      },
    }));
    const response = await handleGithubOperation(
      { operationId: 'threads', op: 'pr.threads', ref },
      { token: 'token', fetch: github.fetch }
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          threads: [
            {
              id: 't1',
              createdAt: '2026-11-11T09:00:00Z',
              commit: 'c1-commit',
              comments: [
                { id: 'c1', createdAt: '2026-11-11T09:00:00Z', commit: 'c1-commit' },
                { id: 'c2', createdAt: '2026-11-11T11:00:00Z', commit: null },
              ],
            },
          ],
        },
      },
    });
  });

  test('a read that GitHub answers 502 is repeated, and one it refuses is not', async () => {
    const page = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [thread('t1', [comment('c1', 'first')])],
            },
          },
        },
      },
    };
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    const answers = [json({}, 502), json({}, 502), json(page)];
    const response = await handleGithubOperation(
      { operationId: 'threads', op: 'pr.threads', ref },
      {
        token: 'token',
        fetch: async () => answers.shift() ?? json({ message: 'unexpected call' }, 500),
        sleep,
      }
    );
    expect(response).toMatchObject({ ok: true, result: { value: { threads: [{ id: 't1' }] } } });
    expect(waits).toEqual([1_000, 2_000]);

    let calls = 0;
    const refused = await handleGithubOperation(
      { operationId: 'threads', op: 'pr.threads', ref },
      {
        token: 'token',
        fetch: async () => {
          calls++;
          return json({}, 403);
        },
        sleep,
      }
    );
    expect(refused).toMatchObject({ ok: false, error: { kind: 'authorization', status: 403 } });
    expect(calls).toBe(1);
  });

  test('a read is repeated three times at most, and a dropped connection counts as transient', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    let calls = 0;
    const down = await handleGithubOperation(
      { operationId: 'threads', op: 'pr.threads', ref },
      {
        token: 'token',
        fetch: async () => {
          calls++;
          return json({}, 502);
        },
        sleep,
      }
    );
    expect(down).toMatchObject({ ok: false });
    expect(calls).toBe(4);
    expect(waits).toEqual([1_000, 2_000, 4_000]);

    const page = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    };
    let drops = 2;
    const recovered = await handleGithubOperation(
      { operationId: 'threads', op: 'pr.threads', ref },
      {
        token: 'token',
        fetch: async () => {
          if (drops-- > 0) throw new TypeError('socket hang up');
          return json(page);
        },
        sleep,
      }
    );
    expect(recovered).toMatchObject({ ok: true, result: { value: { threads: [] } } });
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
