/**
 * A fake GitHub REST/GraphQL API for the real GitHub forge plugin process.
 *
 * Each `archon forge` operation spawns a fresh plugin process, so the fake keeps
 * its one repository's state in a JSON file: a write in one process is what the
 * next process reads back. `install` replaces `fetch` in the plugin process; it is
 * loaded through a generated `--preload` that names the state file.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const FAKE_HOST = 'ghe.example.com';
const ROOT = `https://${FAKE_HOST}/api/v3/repos/example/repo`;
const GRAPHQL = `https://${FAKE_HOST}/api/graphql`;

export interface FakePull {
  number: number;
  node_id: string;
  html_url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  maintainer_can_modify: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string };
}

export interface FakeGitHubState {
  /** The revision a created pull request's head points at. */
  headSha: string;
  pulls: FakePull[];
  comments: { id: number; body: string }[];
  nextComment: number;
  checkRuns: { id: number; name: string; status: string; conclusion: string | null }[];
  /** Every request, as `METHOD url`, so a test can see what was written. */
  calls: string[];
}

export function initialState(headSha: string): FakeGitHubState {
  return {
    headSha,
    pulls: [],
    comments: [],
    nextComment: 900,
    checkRuns: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }],
    calls: [],
  };
}

function comment(row: { id: number; body: string }): Record<string, unknown> {
  return {
    id: row.id,
    body: row.body,
    html_url: `https://${FAKE_HOST}/example/repo/pull/42#issuecomment-${String(row.id)}`,
    issue_url: `${ROOT}/issues/42`,
  };
}

function route(
  state: FakeGitHubState,
  url: URL,
  method: string,
  body: Record<string, unknown> | undefined
): Response {
  const path = `${url.origin}${url.pathname}`;
  const page = Number(url.searchParams.get('page') ?? '1');
  const pull = state.pulls[0];
  if (path === GRAPHQL && method === 'POST' && pull) {
    pull.draft = false;
    return Response.json({
      data: { markPullRequestReadyForReview: { pullRequest: { id: pull.node_id } } },
    });
  }
  if (path === `${ROOT}/pulls` && method === 'GET') {
    const head = url.searchParams.get('head') ?? '';
    return Response.json(
      state.pulls.filter(row => row.state === 'open' && `example:${row.head.ref}` === head)
    );
  }
  if (path === `${ROOT}/pulls` && method === 'POST' && body) {
    const created: FakePull = {
      number: 42,
      node_id: 'PR_node_42',
      html_url: `https://${FAKE_HOST}/example/repo/pull/42`,
      title: String(body.title),
      body: String(body.body),
      state: 'open',
      draft: body.draft === true,
      merged: false,
      maintainer_can_modify: false,
      head: { ref: String(body.head), sha: state.headSha, repo: { full_name: 'example/repo' } },
      base: { ref: String(body.base), sha: 'basesha' },
    };
    state.pulls.push(created);
    return Response.json(created, { status: 201 });
  }
  if (path === `${ROOT}/pulls/42` && pull) {
    if (method === 'PATCH' && typeof body?.body === 'string') pull.body = body.body;
    return Response.json(pull);
  }
  if (path === `${ROOT}/issues/42/comments`) {
    if (method === 'POST' && typeof body?.body === 'string') {
      const row = { id: state.nextComment++, body: body.body };
      state.comments.push(row);
      return Response.json(comment(row), { status: 201 });
    }
    return Response.json(page === 1 ? state.comments.map(comment) : []);
  }
  const commentId = /\/issues\/comments\/(\d+)$/.exec(path)?.[1];
  if (commentId !== undefined) {
    const row = state.comments.find(entry => entry.id === Number(commentId));
    if (!row) return Response.json({ message: 'Not Found' }, { status: 404 });
    if (method === 'PATCH' && typeof body?.body === 'string') row.body = body.body;
    return Response.json(comment(row));
  }
  if (path === `${ROOT}/commits/${state.headSha}/check-runs`) {
    return Response.json({ check_runs: page === 1 ? state.checkRuns : [] });
  }
  if (path === `${ROOT}/commits/${state.headSha}/statuses`) return Response.json([]);
  return Response.json({ message: 'Not Found' }, { status: 404 });
}

export function install(statePath: string): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as FakeGitHubState;
    const method = init?.method ?? 'GET';
    const url = new URL(input instanceof Request ? input.url : input);
    state.calls.push(`${method} ${url.href}`);
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const response = route(state, url, method, body);
    writeFileSync(statePath, JSON.stringify(state));
    return response;
  }) as typeof fetch;
}
