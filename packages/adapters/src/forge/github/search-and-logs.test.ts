import { describe, expect, test } from 'bun:test';
import { forgeResponseSchema, type ForgeRequest } from '@archon/forge/operations';
import type { Fetch } from './api';
import { handleGithubOperation } from './operations';

const repo = { host: 'github.com', path: 'archon/test' };
const API = 'https://api.github.com';
const TOKEN = 'secret-token';

interface Call {
  url: URL;
  authorization: string | null;
  redirect: RequestInit['redirect'];
}

/** A fake GitHub answering by URL, recording each call and whether it carried the token. */
function fakeGitHub(answer: (url: URL) => Response) {
  const calls: Call[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
    });
    return answer(url);
  };
  return { fetch, calls };
}

async function run(request: ForgeRequest, github: { fetch: Fetch }) {
  return forgeResponseSchema.parse(
    await handleGithubOperation(request, { token: TOKEN, fetch: github.fetch })
  );
}

describe('workitem.search', () => {
  const request = {
    operationId: 'search',
    op: 'workitem.search',
    repo,
    text: 'retry backoff',
  } satisfies ForgeRequest;
  const found = (number: number, updated_at: string, pr = false) => ({
    number,
    repository_url: `${API}/repos/archon/test`,
    html_url: `https://github.com/archon/test/${pr ? 'pull' : 'issues'}/${String(number)}`,
    title: `Item ${String(number)}`,
    state: 'open',
    updated_at,
    ...(pr ? { pull_request: {} } : {}),
  });
  const page = (items: unknown[], total = items.length, incomplete = false) =>
    Response.json({ total_count: total, incomplete_results: incomplete, items });
  const kindOf = (url: URL) => (url.searchParams.get('q')?.includes(' is:pr ') ? 'pr' : 'issue');

  test('searches issues and pull requests in the repository, newest update first', async () => {
    const github = fakeGitHub(url =>
      kindOf(url) === 'pr'
        ? page([found(9, '2026-11-03T00:00:00Z', true)])
        : page([found(4, '2026-11-04T00:00:00Z'), found(2, '2026-11-01T00:00:00Z')])
    );
    const response = await run({ ...request, limit: 2 }, github);
    expect(response).toEqual({
      operationId: 'search',
      ok: true,
      result: {
        op: 'workitem.search',
        value: {
          repo,
          text: 'retry backoff',
          items: [
            {
              ref: { repo, number: 4 },
              kind: 'issue',
              url: 'https://github.com/archon/test/issues/4',
              state: 'open',
              title: 'Item 4',
              updatedAt: '2026-11-04T00:00:00Z',
            },
            {
              ref: { repo, number: 9 },
              kind: 'pr',
              url: 'https://github.com/archon/test/pull/9',
              state: 'open',
              title: 'Item 9',
              updatedAt: '2026-11-03T00:00:00Z',
            },
          ],
          // Three matched and two were asked for.
          truncated: true,
        },
      },
    });
    expect(github.calls.map(call => call.url.searchParams.get('q')).sort()).toEqual([
      'repo:archon/test is:issue is:open retry backoff',
      'repo:archon/test is:pr is:open retry backoff',
    ]);
    for (const { url } of github.calls) {
      expect(url.pathname).toBe('/search/issues');
      expect(url.searchParams.get('sort')).toBe('updated');
      expect(url.searchParams.get('per_page')).toBe('2');
    }
  });

  test('one kind in any state asks once, and a page GitHub cut short is reported', async () => {
    const github = fakeGitHub(() => page([found(4, '2026-11-04T00:00:00Z')], 40));
    const response = await run({ ...request, kind: 'issue', state: 'any' }, github);
    expect(response).toMatchObject({ ok: true, result: { value: { truncated: true } } });
    expect(github.calls.map(call => call.url.searchParams.get('q'))).toEqual([
      'repo:archon/test is:issue retry backoff',
    ]);
    expect(github.calls[0]?.url.searchParams.get('per_page')).toBe('30');

    // A search GitHub timed out is partial even when its count matches what it returned.
    const timedOut = fakeGitHub(() => page([found(4, '2026-11-04T00:00:00Z')], 1, true));
    expect(await run({ ...request, kind: 'issue' }, timedOut)).toMatchObject({
      ok: true,
      result: { value: { truncated: true } },
    });
  });

  test('refuses a match from another repository and a search GitHub would not accept', async () => {
    const foreign = fakeGitHub(() =>
      page([{ ...found(4, '2026-11-04T00:00:00Z'), repository_url: `${API}/repos/other/private` }])
    );
    expect(await run({ ...request, kind: 'issue' }, foreign)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_response' },
    });
    const unasked = fakeGitHub(() => page([]));
    expect(await run({ ...request, text: 'word '.repeat(60) }, unasked)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
    });
    expect(unasked.calls).toHaveLength(0);
  });
});

describe('checks.logs', () => {
  const unit = { kind: 'check', id: '71', name: 'test (linux)' } as const;
  const request = { operationId: 'logs', op: 'checks.logs', repo, unit } satisfies ForgeRequest;
  const SIGNED = 'https://logs.example.test/job-71?sig=signed-secret';
  /** GitHub Actions job 71, whose log endpoint answers with `log`. */
  const actions = (log: (url: URL) => Response, slug = 'github-actions') =>
    fakeGitHub(url => {
      if (url.pathname === '/repos/archon/test/check-runs/71')
        return Response.json({ app: { slug } });
      if (url.pathname === '/repos/archon/test/actions/jobs/71/logs')
        return new Response(null, { status: 302, headers: { location: SIGNED } });
      return log(url);
    });
  const logOf = async (github: { fetch: Fetch }, maxBytes?: number) => {
    const response = await run({ ...request, ...(maxBytes ? { maxBytes } : {}) }, github);
    if (!response.ok || response.result.op !== 'checks.logs')
      throw new Error(JSON.stringify(response));
    return response.result.value.log;
  };

  test('returns a whole log, fetching the signed URL without the token', async () => {
    const github = actions(() => new Response('line one\nError: boom\n'));
    expect(await logOf(github)).toEqual({
      kind: 'text',
      text: 'line one\nError: boom\n',
      truncated: false,
      totalBytes: 21,
    });
    expect(github.calls.map(call => [call.url.href, call.authorization, call.redirect])).toEqual([
      [`${API}/repos/archon/test/check-runs/71`, `Bearer ${TOKEN}`, undefined],
      [`${API}/repos/archon/test/actions/jobs/71/logs`, `Bearer ${TOKEN}`, 'manual'],
      [SIGNED, null, undefined],
    ]);
  });

  test('keeps the end of a log longer than the size asked for, on a whole character', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of ['early output\n', 'more\n', 'é', 'Error: boom\n'])
          controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    // Thirteen bytes back from the end lands inside the two-byte "é".
    expect(
      await logOf(
        actions(() => new Response(body)),
        13
      )
    ).toEqual({
      kind: 'text',
      text: 'Error: boom\n',
      truncated: true,
      totalBytes: 32,
    });
  });

  test('a unit without a log is an answer, not an error', async () => {
    const status = fakeGitHub(() => Response.json({}));
    const response = await run(
      { ...request, unit: { kind: 'commit_status', id: '5', name: 'ci/external' } },
      status
    );
    expect(response).toMatchObject({
      ok: true,
      result: { value: { log: { kind: 'none', reason: 'unit_has_no_log' } } },
    });
    expect(status.calls).toHaveLength(0);

    const otherApp = actions(() => new Response('unused'), 'some-ci-app');
    expect(await logOf(otherApp)).toEqual({ kind: 'none', reason: 'unit_has_no_log' });
    expect(otherApp.calls).toHaveLength(1);

    const expired = fakeGitHub(url =>
      url.pathname.endsWith('/logs')
        ? Response.json({}, { status: 410 })
        : Response.json({ app: { slug: 'github-actions' } })
    );
    expect(await logOf(expired)).toEqual({ kind: 'none', reason: 'log_unavailable' });
  });

  test('a failed download names no signed URL, and an unknown check is not found', async () => {
    const denied = actions(() => new Response('denied', { status: 403 }));
    const response = await run(request, denied);
    expect(response).toMatchObject({ ok: false, error: { kind: 'forge_error', status: 403 } });
    expect(JSON.stringify(response)).not.toContain('signed-secret');

    const missing = fakeGitHub(() => Response.json({}, { status: 404 }));
    expect(await run(request, missing)).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
    });
  });
});
