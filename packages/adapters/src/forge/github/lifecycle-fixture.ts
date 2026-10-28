import type { ForgeRequest, ForgeResponse } from '@archon/forge/operations';
import { handleGithubOperation } from './operations';
import { expect } from 'bun:test';
const repo = { host: 'github.com', path: 'archon/test' };
const ROOT = 'https://api.github.com/repos/archon/test';

export function json(value: unknown, status = 200): Response {
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
  user?: { id: number; login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string };
}

export function pull(overrides: Partial<PullState> = {}): PullState {
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
export function fakeGitHub(
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
  const changeDraft = (init?: RequestInit) => {
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
  };
  const commentById = (url: string, method: string, init?: RequestInit) => {
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
  };
  const commentList = (url: string, method: string, init?: RequestInit) => {
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
  };
  const createPull = (init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (!options.lose) {
      state.title = payload.title as string;
      state.body = payload.body as string;
      state.draft = payload.draft as boolean;
    }
    return json(state);
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (options.network?.(url, method)) throw new TypeError('network down');
    const status = options.status?.(url, method);
    if (status !== undefined) return json({ message: 'refused' }, status);
    if (url.includes('/graphql')) {
      return changeDraft(init);
    }
    if (url.endsWith('/repos/archon/test')) return json({ full_name: 'archon/test' });
    if (url.includes('/issues/comments/')) {
      return commentById(url, method, init);
    }
    if (url.includes('/issues/7/comments')) {
      return commentList(url, method, init);
    }
    if (url.includes('/issues/7')) {
      return json({
        number: 7,
        repository_url: ROOT,
        labels: [],
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
      return createPull(init);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetch, state, comments, calls };
}

export function mergeGitHub(
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
  const mergePull = (init: RequestInit) => {
    writes.push(JSON.parse(String(init.body)));
    if (options.lost) throw new Error('token must never escape');
    if (options.status) return json({}, options.status);
    wrote = true;
    return json({ merged: !options.mergedFalse, sha: 'landed' });
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (init?.method === 'PUT') {
      return mergePull(init);
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

export function rerunGitHub(
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
  const postRerun = (runId: string) => {
    posted.push(runId);
    if (options.failureGroup === runId) {
      if (options.failureStatus) return json({}, options.failureStatus);
      throw new Error('network dropped');
    }
    return new Response(null, { status: 201 });
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/pulls/7'))
      return json({ head: { sha: options.prHead ?? 'headsha' } });
    const segments = url.pathname.split('/');
    const id = segments[segments.length - 1];
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
    const runId = init?.method === 'POST' ? segments[segments.length - 2] : id;
    if (init?.method === 'POST') {
      return postRerun(runId);
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

export async function run(
  request: ForgeRequest,
  github: ReturnType<typeof fakeGitHub>
): Promise<ForgeResponse> {
  return handleGithubOperation(request, { token: 'token', fetch: github.fetch });
}
