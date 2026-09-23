import { describe, expect, test } from 'bun:test';
import { runForgeMutationConformance } from '@archon/forge/conformance';
import {
  contentDigest,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import { githubPluginMetadata, handleGithubOperation } from './operations';

const repo = { host: 'github.com', path: 'archon/test' };
const ref = { repo, number: 7 };
const ROOT = 'https://api.github.com/repos/archon/test';

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

interface PullState {
  number: number;
  node_id: string;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged?: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string };
}

function pull(overrides: Partial<PullState> = {}): PullState {
  return {
    number: 7,
    node_id: 'PR_node',
    html_url: 'https://github.com/archon/test/pull/7',
    title: 'A title',
    body: 'A body',
    state: 'open',
    draft: true,
    head: { ref: 'feature', sha: 'headsha', repo: { full_name: 'archon/test' } },
    base: { ref: 'dev', sha: 'basesha' },
    ...overrides,
  };
}

/**
 * A GitHub that applies writes to one pull request and one comment list, so a
 * read-back sees what a write did — or, with `lose`, does not.
 */
function fakeGitHub(
  options: {
    pull?: PullState;
    comments?: { id: number; body: string }[];
    lose?: boolean;
    status?: (url: string, method: string) => number | undefined;
    network?: (url: string, method: string) => boolean;
  } = {}
) {
  const state = options.pull ?? pull();
  const comments = options.comments ?? [];
  const calls: { url: string; method: string }[] = [];
  let nextId = 900;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (options.network?.(url, method)) throw new TypeError('network down');
    const status = options.status?.(url, method);
    if (status !== undefined) return json({ message: 'refused' }, status);
    if (url.includes('/graphql')) {
      if (!options.lose) state.draft = false;
      return json({
        data: { markPullRequestReadyForReview: { pullRequest: { id: state.node_id } } },
      });
    }
    if (url.endsWith('/repos/archon/test')) return json({ full_name: 'archon/test' });
    if (url.includes('/issues/comments/')) {
      const id = Number(url.split('/issues/comments/')[1]);
      if (method === 'PATCH' && !options.lose) {
        const existing = comments.find(row => row.id === id);
        if (existing) existing.body = JSON.parse(String(init?.body)).body as string;
      }
      const row = comments.find(entry => entry.id === id);
      return row === undefined
        ? json({ message: 'gone' }, 404)
        : json({
            id: row.id,
            body: row.body,
            html_url: `https://github.com/archon/test/pull/7#c${String(row.id)}`,
            issue_url: `${ROOT}/issues/7`,
          });
    }
    if (url.includes('/issues/7/comments')) {
      if (method === 'POST') {
        const id = nextId++;
        const body = JSON.parse(String(init?.body)).body as string;
        if (!options.lose) comments.push({ id, body });
        return json({
          id,
          body,
          html_url: `https://github.com/archon/test/pull/7#c${String(id)}`,
          issue_url: `${ROOT}/issues/7`,
        });
      }
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      return json(
        page === 1
          ? comments.map(row => ({
              id: row.id,
              body: row.body,
              html_url: `https://github.com/archon/test/pull/7#c${String(row.id)}`,
              issue_url: `${ROOT}/issues/7`,
            }))
          : []
      );
    }
    if (url.includes('/issues/7')) {
      return json({
        html_url: 'https://github.com/archon/test/issues/7',
        title: 'Issue title',
        body: 'Issue body',
        state: 'open',
      });
    }
    if (url.includes('/pulls?')) return json([state]);
    if (url.includes('/pulls/7')) {
      if (method === 'PATCH' && !options.lose) {
        state.body = JSON.parse(String(init?.body)).body as string;
      }
      return json(state);
    }
    if (url.endsWith('/pulls') && method === 'POST') {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!options.lose) {
        state.title = payload.title as string;
        state.body = payload.body as string;
        state.draft = payload.draft as boolean;
      }
      return json(state);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetch, state, comments, calls };
}

async function run(
  request: ForgeRequest,
  github: ReturnType<typeof fakeGitHub>
): Promise<ForgeResponse> {
  return handleGithubOperation(request, { token: 'token', fetch: github.fetch });
}

const marker = '<!-- archon-review-report -->';
const report = `${marker}\nRound 1`;

describe('GitHub lifecycle reads', () => {
  test('reads a work item and distinguishes a pull request from an issue', async () => {
    const response = await run(
      { operationId: 'view-item', op: 'workitem.view', ref },
      fakeGitHub()
    );
    expect(response).toMatchObject({
      ok: true,
      result: { op: 'workitem.view', value: { ref, kind: 'issue', title: 'Issue title' } },
    });
  });

  test('reads a pull request by number and by qualified open head', async () => {
    const byNumber = await run(
      { operationId: 'by-number', op: 'pr.view', selector: { kind: 'number', ref } },
      fakeGitHub()
    );
    expect(byNumber).toMatchObject({
      ok: true,
      result: {
        op: 'pr.view',
        value: { pr: { number: 7, head: 'feature', base: 'dev', state: 'open' }, title: 'A title' },
      },
    });

    const github = fakeGitHub();
    const byHead = await run(
      {
        operationId: 'by-head',
        op: 'pr.view',
        selector: { kind: 'head', repo, headRepo: repo, head: 'feature' },
      },
      github
    );
    expect(byHead).toMatchObject({
      ok: true,
      result: { op: 'pr.view', value: { pr: { number: 7 } } },
    });
    // A closed pull request on the same branch must not answer for the head, so
    // the query never widens past GitHub's default open state.
    expect(github.calls.some(call => call.url.includes('state=all'))).toBe(false);
  });

  test('reports no pull request for a head that has none', async () => {
    const github = fakeGitHub();
    const empty = { ...github, fetch: async () => json([]) };
    const response = await run(
      {
        operationId: 'no-head',
        op: 'pr.view',
        selector: { kind: 'head', repo, headRepo: repo, head: 'gone' },
      },
      empty as ReturnType<typeof fakeGitHub>
    );
    expect(response).toMatchObject({ ok: true, result: { op: 'pr.view', value: null } });
  });
});

describe('GitHub mutations report which of the four outcomes happened', () => {
  const create = {
    operationId: 'create',
    op: 'pr.create',
    repo,
    headRepo: repo,
    head: 'feature',
    headRevision: 'headsha',
    base: 'dev',
    title: 'A title',
    body: 'A body',
    draft: true,
  } satisfies ForgeMutationRequest;

  test('applied: the write is reported only after it reads back', async () => {
    const github = fakeGitHub({ pull: pull({ title: 'stale', body: 'stale', draft: false }) });
    const created = await run(create, github);
    expect(created).toMatchObject({
      ok: true,
      result: { op: 'pr.create', value: { outcome: 'applied', changed: true, pr: { number: 7 } } },
    });

    const edited = await run(
      { operationId: 'edit', op: 'pr.edit-body', ref, body: 'A new body' },
      github
    );
    expect(edited).toMatchObject({
      ok: true,
      result: {
        op: 'pr.edit-body',
        value: { outcome: 'applied', changed: true, bodyDigest: contentDigest('A new body') },
      },
    });

    const ready = await run({ operationId: 'ready', op: 'pr.ready', ref }, github);
    expect(ready).toMatchObject({
      ok: true,
      result: {
        op: 'pr.ready',
        value: { outcome: 'applied', changed: true, pr: { is_draft: false } },
      },
    });
  });

  test('applied: GitHub may echo the head repository in its registered case', async () => {
    const github = fakeGitHub({
      pull: pull({
        title: 'stale',
        body: 'stale',
        draft: false,
        head: { ref: 'feature', sha: 'headsha', repo: { full_name: 'Archon/Test' } },
      }),
    });
    const created = await run(create, github);
    expect(created).toMatchObject({
      ok: true,
      result: {
        op: 'pr.create',
        value: { outcome: 'applied', pr: { head_repo: { path: 'Archon/Test' } } },
      },
    });
  });

  test('applied with changed false: an already-current write submits nothing', async () => {
    const github = fakeGitHub({ pull: pull({ body: 'same', draft: false }) });
    const edited = await run(
      { operationId: 'edit', op: 'pr.edit-body', ref, body: 'same' },
      github
    );
    expect(edited).toMatchObject({
      ok: true,
      result: { op: 'pr.edit-body', value: { outcome: 'applied', changed: false } },
    });
    const ready = await run({ operationId: 'ready', op: 'pr.ready', ref }, github);
    expect(ready).toMatchObject({
      ok: true,
      result: { op: 'pr.ready', value: { outcome: 'applied', changed: false } },
    });
    expect(github.calls.filter(call => call.method !== 'GET')).toEqual([]);
  });

  test('refused: GitHub decided against the request, so nothing was written', async () => {
    const conflict = await run(
      create,
      fakeGitHub({ status: (_url, method) => (method === 'POST' ? 422 : undefined) })
    );
    expect(conflict).toMatchObject({
      ok: false,
      error: { kind: 'conflict', status: 422 },
      mutation: { op: 'pr.create', outcome: 'refused' },
    });

    const merged = await run(
      { operationId: 'ready', op: 'pr.ready', ref },
      fakeGitHub({ pull: pull({ merged: true, state: 'closed' }) })
    );
    expect(merged).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { op: 'pr.ready', outcome: 'refused', observed: { state: 'merged' } },
    });

    const unmarked = await run(
      { operationId: 'comment', op: 'comment.upsert', ref, marker, body: 'no marker here' },
      fakeGitHub()
    );
    expect(unmarked).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
      mutation: { op: 'comment.upsert', outcome: 'refused' },
    });

    const ambiguous = await run(
      { operationId: 'comment', op: 'comment.upsert', ref, marker, body: report },
      fakeGitHub({
        comments: [
          { id: 1, body: report },
          { id: 2, body: `${marker}\nother` },
        ],
      })
    );
    expect(ambiguous).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { op: 'comment.upsert', outcome: 'refused' },
    });
  });

  test('verification failed: a silent vendor refusal is never reported as success', async () => {
    const edited = await run(
      { operationId: 'edit', op: 'pr.edit-body', ref, body: 'A new body' },
      fakeGitHub({ lose: true })
    );
    expect(edited).toMatchObject({
      ok: false,
      error: { kind: 'invalid_response' },
      mutation: {
        op: 'pr.edit-body',
        outcome: 'verification_failed',
        leaveBehind: 'the pull request body may have changed',
        observed: { number: 7 },
      },
    });

    const ready = await run(
      { operationId: 'ready', op: 'pr.ready', ref },
      fakeGitHub({ lose: true })
    );
    expect(ready).toMatchObject({
      ok: false,
      mutation: { op: 'pr.ready', outcome: 'verification_failed' },
    });

    const comment = await run(
      { operationId: 'comment', op: 'comment.upsert', ref, marker, body: report },
      fakeGitHub({ lose: true })
    );
    expect(comment).toMatchObject({
      ok: false,
      mutation: { op: 'comment.upsert', outcome: 'verification_failed' },
    });
  });

  test('verification failed: the read-back after an acknowledged write could not run', async () => {
    let submitted = false;
    const github = fakeGitHub({
      status: (url, method) => {
        if (method === 'PATCH') {
          submitted = true;
          return undefined;
        }
        return submitted && url.includes('/pulls/7') ? 500 : undefined;
      },
    });
    const response = await run(
      { operationId: 'edit', op: 'pr.edit-body', ref, body: 'A new body' },
      github
    );
    expect(response).toMatchObject({
      ok: false,
      mutation: { op: 'pr.edit-body', outcome: 'verification_failed' },
    });
  });

  test('outcome unknown: the request was submitted and its answer was lost', async () => {
    const dropped = await run(create, fakeGitHub({ network: (_url, method) => method === 'POST' }));
    expect(dropped).toMatchObject({
      ok: false,
      error: { kind: 'forge_error' },
      mutation: { op: 'pr.create', outcome: 'outcome_unknown' },
    });

    const server = await run(
      { operationId: 'edit', op: 'pr.edit-body', ref, body: 'A new body' },
      fakeGitHub({ status: (_url, method) => (method === 'PATCH' ? 503 : undefined) })
    );
    expect(server).toMatchObject({
      ok: false,
      mutation: { op: 'pr.edit-body', outcome: 'outcome_unknown' },
    });
  });

  test('a missing credential refuses every mutation before it reaches GitHub', async () => {
    const response = await handleGithubOperation(create, { token: undefined });
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'no_credential' },
      mutation: { op: 'pr.create', outcome: 'refused' },
    });
  });
});

describe('the canonical comment is one comment across rounds', () => {
  test('creates it once and then edits the same one in place', async () => {
    const github = fakeGitHub({ comments: [{ id: 1, body: 'an unrelated comment' }] });
    const first = await run(
      { operationId: 'round-1', op: 'comment.upsert', ref, marker, body: report },
      github
    );
    expect(first).toMatchObject({
      ok: true,
      result: { op: 'comment.upsert', value: { outcome: 'applied', changed: true } },
    });

    const round2 = `${marker}\nRound 2`;
    const second = await run(
      { operationId: 'round-2', op: 'comment.upsert', ref, marker, body: round2 },
      github
    );
    expect(second).toMatchObject({
      ok: true,
      result: {
        op: 'comment.upsert',
        value: {
          outcome: 'applied',
          changed: true,
          comment: { bodyDigest: contentDigest(round2) },
        },
      },
    });
    expect(github.comments).toEqual([
      { id: 1, body: 'an unrelated comment' },
      { id: 900, body: round2 },
    ]);
  });

  test('a comment GitHub echoes in its registered repository case still verifies', async () => {
    const github = fakeGitHub();
    const response = await run(
      {
        operationId: 'case',
        op: 'comment.upsert',
        ref: { repo: { host: 'github.com', path: 'Archon/Test' }, number: 7 },
        marker,
        body: report,
      },
      github
    );
    expect(response).toMatchObject({
      ok: true,
      result: { op: 'comment.upsert', value: { outcome: 'applied', changed: true } },
    });
  });

  test('an unchanged round writes nothing and still verifies', async () => {
    const github = fakeGitHub({ comments: [{ id: 5, body: report }] });
    const response = await run(
      { operationId: 'again', op: 'comment.upsert', ref, marker, body: report },
      github
    );
    expect(response).toMatchObject({
      ok: true,
      result: { op: 'comment.upsert', value: { outcome: 'applied', changed: false } },
    });
    expect(github.calls.every(call => call.method === 'GET')).toBe(true);
  });
});

test('passes the public mutation conformance kit for every outcome', async () => {
  const cases = [
    {
      name: 'applied',
      github: fakeGitHub(),
      request: { operationId: 'c-applied', op: 'pr.edit-body', ref, body: 'next' },
      expectedOutcome: 'applied' as const,
    },
    {
      name: 'refused',
      github: fakeGitHub({
        status: (_url: string, method: string) => (method === 'PATCH' ? 403 : undefined),
      }),
      request: { operationId: 'c-refused', op: 'pr.edit-body', ref, body: 'next' },
      expectedOutcome: 'refused' as const,
    },
    {
      name: 'verification failed',
      github: fakeGitHub({ lose: true }),
      request: { operationId: 'c-unverified', op: 'pr.edit-body', ref, body: 'next' },
      expectedOutcome: 'verification_failed' as const,
    },
    {
      name: 'outcome unknown',
      github: fakeGitHub({
        status: (_url: string, method: string) => (method === 'PATCH' ? 502 : undefined),
      }),
      request: { operationId: 'c-unknown', op: 'pr.edit-body', ref, body: 'next' },
      expectedOutcome: 'outcome_unknown' as const,
    },
  ] satisfies {
    name: string;
    github: ReturnType<typeof fakeGitHub>;
    request: ForgeMutationRequest;
    expectedOutcome: string;
  }[];

  const failures = await runForgeMutationConformance(
    async request => {
      const fixture = cases.find(entry => entry.request.operationId === request.operationId);
      if (!fixture) throw new Error(`unknown conformance request ${request.operationId}`);
      return run(request, fixture.github);
    },
    githubPluginMetadata,
    cases.map(({ name, request, expectedOutcome }) => ({ name, request, expectedOutcome }))
  );
  expect(failures).toEqual([]);
});
