import { describe, expect, test } from 'bun:test';
import { runForgeMutationConformance } from '@archon/forge/conformance';
import {
  contentDigest,
  forgeResponseSchema,
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
      const payload = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { id: string };
      };
      expect(payload.variables.id).toBe(state.node_id);
      const mutation = payload.query.includes('convertPullRequestToDraft')
        ? 'convertPullRequestToDraft'
        : 'markPullRequestReadyForReview';
      if (!options.lose) state.draft = mutation === 'convertPullRequestToDraft';
      return json({ data: { [mutation]: { pullRequest: { id: state.node_id } } } });
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

const mergeRequest = {
  operationId: 'merge',
  op: 'pr.merge',
  ref,
  method: 'squash',
  conditions: { head: 'headsha' },
} satisfies ForgeMutationRequest;

function mergeGitHub(
  options: {
    stale?: boolean;
    status?: number;
    lost?: boolean;
    mismatch?: boolean;
    commitMismatch?: boolean;
    supplementalMissing?: boolean;
    mergedFalse?: boolean;
    readFailed?: boolean;
  } = {}
) {
  let wrote = false;
  const writes: unknown[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (init?.method === 'PUT') {
      writes.push(JSON.parse(String(init.body)));
      if (options.lost) throw new Error('token must never escape');
      if (options.status) return json({}, options.status);
      wrote = true;
      return json({ merged: !options.mergedFalse, sha: 'landed' });
    }
    if (url.includes('/git/commits/')) {
      if (options.supplementalMissing) return json({}, 403);
      return json({
        sha: options.commitMismatch ? 'wrong' : 'landed',
        tree: { sha: 'landed-tree' },
        parents: [{ sha: 'base' }, { sha: 'headsha' }],
      });
    }
    if (wrote && options.readFailed) return json({}, 500);
    return json({
      ...pull({ draft: false, merged: wrote, state: wrote ? 'closed' : 'open' }),
      head: {
        ref: 'feature',
        sha: options.stale || (wrote && options.mismatch) ? 'other' : 'headsha',
        repo: { full_name: repo.path },
      },
      merge_commit_sha: wrote ? 'landed' : null,
    });
  };
  return { fetch, writes };
}

test.each(['merge', 'squash'] as const)(
  'merges with %s and the exact approved head, then reads ordered landed evidence',
  async method => {
    const github = mergeGitHub();
    const failures = await runForgeMutationConformance(
      request => handleGithubOperation(request, { token: 'token', fetch: github.fetch }),
      githubPluginMetadata,
      [{ name: method, request: { ...mergeRequest, method }, expectedOutcome: 'applied' }]
    );
    expect(failures).toEqual([]);
    expect(github.writes).toEqual([{ sha: 'headsha', merge_method: method }]);
    const response = await handleGithubOperation(
      { ...mergeRequest, method },
      { token: 'token', fetch: mergeGitHub().fetch }
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        value: {
          landed: { commit: 'landed', tree: 'landed-tree', parents: ['base', 'headsha'] },
          enforcedConditions: ['head'],
        },
      },
    });
  }
);

test('merge refuses stale and unsupported conditions before writing', async () => {
  for (const conditions of [
    {},
    { head: 'headsha', base: 'base' },
    { head: 'headsha', tree: 'tree' },
    { head: 'headsha' },
  ]) {
    const github = mergeGitHub({ stale: true });
    const response = await handleGithubOperation(
      { ...mergeRequest, conditions },
      { token: 'token', fetch: github.fetch }
    );
    expect(response).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
    expect(github.writes).toEqual([]);
  }
});

test.each([
  [{ status: 409 }, 'refused'],
  [{ lost: true }, 'outcome_unknown'],
  [{ mismatch: true }, 'verification_failed'],
  [{ commitMismatch: true }, 'verification_failed'],
  [{ readFailed: true }, 'verification_failed'],
  [{ mergedFalse: true }, 'refused'],
] as const)('merge reports truthful failure evidence for %j', async (options, outcome) => {
  const github = mergeGitHub(options);
  const response = await handleGithubOperation(mergeRequest, {
    token: 'token',
    fetch: github.fetch,
  });
  expect(response).toMatchObject({
    ok: false,
    mutation: { outcome, merge: { method: 'squash', conditions: { head: 'headsha' } } },
  });
  expect(JSON.stringify(response)).not.toContain('token must never escape');
  expect(github.writes).toHaveLength(1);
});

test('unavailable supplemental merge evidence remains explicitly null', async () => {
  expect(
    await handleGithubOperation(mergeRequest, {
      token: 'token',
      fetch: mergeGitHub({ supplementalMissing: true }).fetch,
    })
  ).toMatchObject({
    ok: true,
    result: { value: { landed: { commit: 'landed', tree: null, parents: null } } },
  });
});

const selected = (id: number, runId = 100) => ({
  unit: { kind: 'check' as const, id: String(id), name: 'same-name' },
  rerun: { id: String(runId), attempt: 1 },
});
const rerunRequest = {
  operationId: 'rerun',
  op: 'checks.rerun',
  ref,
  revision: 'headsha',
  units: [selected(1), selected(2)],
} satisfies ForgeMutationRequest;
function rerunGitHub(
  options: {
    prHead?: string;
    check?: Record<string, unknown>;
    run?: Record<string, unknown>;
    oldAttempt?: boolean;
    failureGroup?: string;
    failureStatus?: number;
    readFailed?: boolean;
  } = {}
) {
  const posted: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/pulls/7'))
      return json({ head: { sha: options.prHead ?? 'headsha' } });
    const id = url.pathname.split('/').at(-1)!;
    if (url.pathname.includes('/check-runs/'))
      return json({
        id: Number(id),
        name: 'same-name',
        head_sha: 'headsha',
        status: 'completed',
        conclusion: 'cancelled',
        app: { slug: 'github-actions' },
        check_suite: { id: Number(id) === 3 ? 200 : 100 },
        ...options.check,
      });
    const runId = init?.method === 'POST' ? url.pathname.split('/').at(-2)! : id;
    if (init?.method === 'POST') {
      posted.push(runId);
      if (options.failureGroup === runId) {
        if (options.failureStatus) return json({}, options.failureStatus);
        throw new Error('network dropped');
      }
      return new Response(null, { status: 201 });
    }
    if (posted.includes(runId) && options.readFailed) return json({}, 500);
    return json({
      id: Number(runId),
      head_sha: 'headsha',
      check_suite_id: Number(runId),
      run_attempt: posted.includes(runId) && !options.oldAttempt ? 2 : 1,
      status: 'completed',
      conclusion: 'failure',
      ...options.run,
    });
  };
  return { fetch, posted };
}

test('reruns failed jobs once per owning run and verifies a newer attempt', async () => {
  const github = rerunGitHub();
  const failures = await runForgeMutationConformance(
    request => handleGithubOperation(request, { token: 'token', fetch: github.fetch }),
    githubPluginMetadata,
    [{ name: 'rerun', request: rerunRequest, expectedOutcome: 'applied' }]
  );
  expect(failures).toEqual([]);
  expect(github.posted).toEqual(['100']);
});

test('unsupported later units prevent every rerun write', async () => {
  const github = rerunGitHub();
  const units = [
    ...rerunRequest.units,
    { unit: { kind: 'commit_status' as const, id: 'status', name: 'status' }, rerun: null },
  ];
  expect(
    await handleGithubOperation({ ...rerunRequest, units }, { token: 'token', fetch: github.fetch })
  ).toMatchObject({
    ok: false,
    error: { kind: 'unsupported_op' },
    mutation: { outcome: 'refused' },
  });
  expect(github.posted).toEqual([]);
});

test.each([
  { check: { app: { slug: 'another-app' } } },
  { check: { head_sha: 'old' } },
  { check: { status: 'in_progress' } },
  { check: { conclusion: 'success' } },
  { check: { conclusion: 'action_required' } },
  { run: { check_suite_id: 99 } },
  { run: { run_attempt: 2 } },
  { run: { head_sha: 'old' } },
])('invalid check/run association is refused with zero writes: %j', async options => {
  const github = rerunGitHub(options);
  expect(
    await handleGithubOperation(rerunRequest, { token: 'token', fetch: github.fetch })
  ).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
  expect(github.posted).toEqual([]);
});

test.each([{ oldAttempt: true }, { readFailed: true }])(
  'acknowledged rerun without newer attempt evidence fails verification: %j',
  async options => {
    const github = rerunGitHub(options);
    expect(
      await handleGithubOperation(rerunRequest, { token: 'token', fetch: github.fetch })
    ).toMatchObject({ ok: false, mutation: { outcome: 'verification_failed' } });
    expect(github.posted).toEqual(['100']);
  }
);

test.each([
  [403, 'verification_failed'],
  [undefined, 'outcome_unknown'],
] as const)(
  'partial reruns retain observed attempts and stop on a later failure (%s)',
  async (failureStatus, outcome) => {
    const github = rerunGitHub({ failureGroup: '200', failureStatus });
    const units = [selected(1), selected(3, 200), selected(4, 300)];
    // The third group must also validate before the first submission.
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/check-runs/4'))
        return json({
          id: 4,
          name: 'same-name',
          head_sha: 'headsha',
          status: 'completed',
          conclusion: 'failure',
          app: { slug: 'github-actions' },
          check_suite: { id: 300 },
        });
      return github.fetch(input, init);
    };
    const response = await handleGithubOperation(
      { ...rerunRequest, units },
      { token: 'token', fetch }
    );
    expect(response).toMatchObject({
      ok: false,
      mutation: {
        outcome,
        rerun: { observed: [{ unit: units[0].unit, rerun: { id: '100', attempt: 2 } }] },
      },
    });
    expect(github.posted).toEqual(['100', '200']);
  }
);

test('reviews paginate submissions and root diff comments, retaining author and commit', async () => {
  const item = {
    id: 1,
    html_url: 'https://github.com/a/b/pull/7#review-1',
    body: 'private body',
    user: { id: 2, login: 'reviewer' },
    commit_id: 'headsha',
    state: 'COMMENTED',
    submitted_at: '2026-10-06T10:00:00Z',
    created_at: '2026-10-06T10:00:00Z',
  };
  const calls: string[] = [];
  const response = await handleGithubOperation(
    { operationId: 'reviews', op: 'pr.reviews', ref },
    {
      token: 'token',
      fetch: async input => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/reviews'))
          return json(
            url.endsWith('page=1')
              ? Array.from({ length: 100 }, (_, id) => ({ ...item, id }))
              : [
                  { ...item, id: 101, state: 'PENDING' },
                  { ...item, id: 102, state: 'DISMISSED' },
                ]
          );
        return json([
          { ...item, state: undefined },
          { ...item, id: 2, in_reply_to_id: 1 },
          { ...item, id: 3, user: null, commit_id: null, created_at: null },
        ]);
      },
    }
  );
  expect(response).toMatchObject({ ok: true, result: { op: 'pr.reviews' } });
  if (!response.ok || response.result.op !== 'pr.reviews') throw new Error('expected reviews');
  expect(response.result.value.items).toHaveLength(103);
  expect(response.result.value.items.at(-2)).toMatchObject({
    kind: 'review_comment',
    author: { host: repo.host, id: '2', login: 'reviewer' },
    commit: 'headsha',
    state: null,
  });
  expect(response.result.value.items.at(-1)).toMatchObject({
    author: null,
    commit: null,
    createdAt: null,
  });
  expect(calls.some(url => url.endsWith('page=2'))).toBe(true);
});

test('a moved PR head refuses reruns of otherwise valid historical checks without writing', async () => {
  const github = rerunGitHub({ prHead: 'new-head' });
  expect(
    await handleGithubOperation(rerunRequest, { token: 'token', fetch: github.fetch })
  ).toMatchObject({ ok: false, mutation: { outcome: 'refused' } });
  expect(github.posted).toEqual([]);
});

test.each([
  { user: { id: 2, login: '' } },
  { user: { id: 2, login: '   ' } },
  { commit_id: '' },
  { commit_id: '   ' },
  { state: '' },
  { submitted_at: 'invalid-timestamp' },
  { created_at: 'invalid-timestamp' },
])('invalid review facts return a contract-valid failure: %j', async invalid => {
  const response = await handleGithubOperation(
    { operationId: 'reviews', op: 'pr.reviews', ref },
    {
      token: 'token must never escape',
      fetch: async () =>
        json([
          {
            id: 1,
            html_url: 'https://github.com/archon/test/pull/7#review-1',
            body: 'private body',
            user: { id: 2, login: 'reviewer' },
            commit_id: 'headsha',
            state: 'COMMENTED',
            submitted_at: '2026-10-06T10:00:00Z',
            created_at: '2026-10-06T10:00:00Z',
            ...invalid,
          },
        ]),
    }
  );
  expect(response).toMatchObject({ ok: false, error: { kind: 'forge_error' } });
  expect(forgeResponseSchema.safeParse(response).success).toBe(true);
  expect(JSON.stringify(response)).not.toContain('token must never escape');
  expect(JSON.stringify(response)).not.toContain('private body');
});

test.each(['pr.ready', 'pr.draft'] as const)(
  '%s requires acknowledgement of the selected mutation before read-back',
  async op => {
    const github = fakeGitHub({ pull: pull({ draft: op === 'pr.ready' }) });
    const otherMutation =
      op === 'pr.ready' ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
    let reads = 0;
    const response = await handleGithubOperation(
      { operationId: 'draft-state', op, ref },
      {
        token: 'token',
        fetch: async (input, init) => {
          if (init?.method === 'POST')
            return json({ data: { [otherMutation]: { pullRequest: { id: 'PR_node' } } } });
          reads++;
          return github.fetch(input, init);
        },
      }
    );
    expect(response).toMatchObject({ ok: false, mutation: { op, outcome: 'outcome_unknown' } });
    expect(reads).toBe(1);
  }
);

describe('GitHub draft conversion', () => {
  const request = { operationId: 'draft', op: 'pr.draft', ref } satisfies ForgeMutationRequest;

  test.each([false, true])('verifies draft state from initial draft=%s', async draft => {
    const github = fakeGitHub({ pull: pull({ draft }) });
    expect(await run(request, github)).toMatchObject({
      ok: true,
      result: {
        op: 'pr.draft',
        value: { outcome: 'applied', changed: !draft, pr: { state: 'open', is_draft: true } },
      },
    });
    expect(github.calls.filter(call => call.method === 'POST')).toHaveLength(draft ? 0 : 1);
  });

  test.each([false, true])('refuses closed PRs (merged=%s) without writing', async merged => {
    const github = fakeGitHub({ pull: pull({ state: 'closed', merged, draft: false }) });
    expect(await run(request, github)).toMatchObject({
      ok: false,
      mutation: {
        op: 'pr.draft',
        outcome: 'refused',
        observed: { state: merged ? 'merged' : 'closed' },
      },
    });
    expect(github.calls.every(call => call.method === 'GET')).toBe(true);
  });

  test.each([
    ['mismatch', 'verification_failed'],
    ['read failure', 'verification_failed'],
    ['lost response', 'outcome_unknown'],
    ['authorization', 'refused'],
    ['GraphQL errors', 'outcome_unknown'],
    ['wrong acknowledgement', 'outcome_unknown'],
    ['closed read-back', 'verification_failed'],
  ] as const)('reports %s truthfully', async (mode, outcome) => {
    let posted = false;
    const github = fakeGitHub({ pull: pull({ draft: false }), lose: mode === 'mismatch' });
    const response = await handleGithubOperation(request, {
      token: 'secret-token',
      fetch: async (input, init) => {
        if (init?.method === 'POST') {
          posted = true;
          if (mode === 'lost response') throw new Error('secret-token');
          if (mode === 'authorization') return json({}, 403);
          if (mode === 'GraphQL errors') return json({ errors: [{ message: 'secret-token' }] });
          if (mode === 'wrong acknowledgement')
            return json({ data: { convertPullRequestToDraft: { pullRequest: { id: 'wrong' } } } });
        } else if (posted) {
          if (mode === 'read failure') return json({}, 500);
          if (mode === 'closed read-back') return json(pull({ state: 'closed' }));
        }
        return github.fetch(input, init);
      },
    });
    expect(response).toMatchObject({ ok: false, mutation: { op: 'pr.draft', outcome } });
    expect(forgeResponseSchema.safeParse(response).success).toBe(true);
    expect(JSON.stringify(response)).not.toContain('secret-token');
  });
});
