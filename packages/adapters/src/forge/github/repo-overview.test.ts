import { describe, expect, test } from 'bun:test';
import {
  runForgeOverviewConformance,
  type ForgeOverviewConformanceCase,
} from '@archon/forge/conformance';
import { forgeResponseSchema, type ForgeRequest } from '@archon/forge/operations';
import type { Fetch } from './api';
import { githubPluginMetadata, handleGithubOperation } from './operations';

const repo = { host: 'github.com', path: 'archon/test' };
const WEB = 'https://github.com/archon/test';
const request = {
  operationId: 'overview',
  op: 'repo.overview',
  repo,
  since: '2026-11-20T10:00:00+02:00',
} satisfies ForgeRequest;

const node = (number: number, kind: 'pull' | 'issues') => ({
  number,
  title: `Item ${String(number)}`,
  url: `${WEB}/${kind}/${String(number)}`,
  updatedAt: '2026-11-21T00:00:00Z',
  author: { __typename: 'User', login: 'octo', id: 'U_1', databaseId: 7 },
  labels: { nodes: [{ name: 'factory' }] },
});
const counts = {
  issues_open: 12,
  issues_unlabeled: 4,
  issues_bugs: 2,
  issues_assigned_to_actor: 1,
  prs_open: 3,
  prs_draft: 0,
  prs_review_requested_from_actor: 0,
  prs_merged_since: 9,
  issues_closed_since: 8,
};
const repository = {
  nameWithOwner: 'archon/test',
  description: 'A test repository',
  url: WEB,
  stargazerCount: 40,
  forkCount: 5,
  defaultBranchRef: { name: 'dev' },
  latestRelease: { tagName: 'v1.2.0', url: `${WEB}/releases/tag/v1.2.0` },
  bugLabel: { name: 'bug' },
  pullRequests: { nodes: [{ ...node(9, 'pull'), isDraft: true }] },
  issues: { nodes: [node(7, 'issues'), { ...node(4, 'issues'), author: null }] },
};
const document = (data: Record<string, unknown> = {}) => ({
  data: {
    viewer: { login: 'octo' },
    repository,
    ...Object.fromEntries(Object.entries(counts).map(([stat, n]) => [stat, { issueCount: n }])),
    ...data,
  },
});

type Variables = Record<string, unknown>;
/** A fake GitHub GraphQL endpoint answering by the query's variables, recording each. */
function fakeGitHub(answer: (variables: Variables) => unknown, status = 200) {
  const calls: Variables[] = [];
  const fetch: Fetch = async (_input, init) => {
    const { variables } = JSON.parse(String(init?.body)) as { variables: Variables };
    calls.push(variables);
    return Response.json(answer(variables), { status });
  };
  return { fetch, calls };
}
const invoke = (github: { fetch: Fetch }) => (asked: ForgeRequest) =>
  handleGithubOperation(asked, { token: 'secret-token', fetch: github.fetch });
const overviewOf = async (github: { fetch: Fetch }) => {
  const response = forgeResponseSchema.parse(await invoke(github)(request));
  if (!response.ok || response.result.op !== 'repo.overview')
    throw new Error(JSON.stringify(response));
  return response.result.value;
};
const conformance = (
  github: { fetch: Fetch },
  expected: ForgeOverviewConformanceCase['expected']
) =>
  runForgeOverviewConformance(invoke(github), githubPluginMetadata, [
    { name: 'overview', request, expected },
  ]);

describe('repo.overview', () => {
  test('answers every fact, count and list of a repository from one request', async () => {
    const github = fakeGitHub(() => document());
    expect(
      await conformance(github, { counts, absent: [], pullRequests: [9], issues: [7, 4] })
    ).toEqual([]);
    expect(github.calls).toHaveLength(1);
    // The window reaches GitHub in UTC to the second; the account's own counts ask for `@me`.
    expect(github.calls[0]).toMatchObject({
      owner: 'archon',
      name: 'test',
      limit: 5,
      prs_merged_since: 'repo:archon/test is:pr is:merged merged:>=2026-11-20T08:00:00Z',
      issues_assigned_to_actor: 'repo:archon/test is:issue is:open assignee:@me',
    });

    const value = await overviewOf(github);
    expect(value).toMatchObject({
      url: WEB,
      name: 'archon/test',
      description: 'A test repository',
      stars: 40,
      forks: 5,
      default_branch: 'dev',
      latest_release: { name: 'v1.2.0', url: `${WEB}/releases/tag/v1.2.0` },
      actor: { login: 'octo' },
      pull_requests: [{ kind: 'pr', is_draft: true, labels: ['factory'] }],
      issues: [
        { author: { host: 'github.com', id: '7', login: 'octo', type: 'user' } },
        { author: null },
      ],
    });
    // Each link is GitHub's own page for the counted list, naming the account by login.
    expect(value.stats.issues_unlabeled?.url).toBe(
      `${WEB}/issues?q=is%3Aissue%20is%3Aopen%20no%3Alabel`
    );
    expect(value.stats.prs_review_requested_from_actor?.url).toBe(
      `${WEB}/pulls?q=is%3Apr%20is%3Aopen%20review-requested%3Aocto`
    );
    expect(value.stats.prs_merged_since?.url).toBe(
      `${WEB}/pulls?q=is%3Apr%20is%3Amerged%20merged%3A%3E%3D2026-11-20T08%3A00%3A00Z`
    );
  });

  test('a repository with no bug label or release reports neither as zero', async () => {
    const github = fakeGitHub(() =>
      document({
        repository: {
          ...repository,
          description: null,
          bugLabel: null,
          latestRelease: null,
          defaultBranchRef: null,
          pullRequests: { nodes: [] },
        },
        // GitHub counts a search for a label that does not exist as zero.
        issues_bugs: { issueCount: 0 },
      })
    );
    expect(
      await conformance(github, {
        counts: { issues_open: 12, prs_draft: 0 },
        absent: ['issues_bugs'],
        pullRequests: [],
        issues: [7, 4],
      })
    ).toEqual([]);
    const value = await overviewOf(github);
    expect(value).toMatchObject({ description: null, latest_release: null });
    expect(value).not.toHaveProperty('default_branch');
  });

  test('a token with no user account still answers, without the account’s own facts', async () => {
    const github = fakeGitHub(variables =>
      variables.actor === true
        ? {
            data: null,
            errors: [
              { type: 'FORBIDDEN', path: ['viewer'], message: 'Resource not accessible' },
              { path: ['issues_assigned_to_actor'], message: 'No user for @me' },
            ],
          }
        : document({
            viewer: undefined,
            issues_assigned_to_actor: undefined,
            prs_review_requested_from_actor: undefined,
          })
    );
    expect(
      await conformance(github, {
        counts: { issues_open: 12, issues_bugs: 2 },
        absent: ['issues_assigned_to_actor', 'prs_review_requested_from_actor'],
        pullRequests: [9],
        issues: [7, 4],
      })
    ).toEqual([]);
    expect(github.calls.map(call => call.actor)).toEqual([true, false]);
    expect(await overviewOf(github)).not.toHaveProperty('actor');
  });

  test('any other refusal fails the read with its kind, never a partial overview', async () => {
    const run = async (github: { fetch: Fetch }) =>
      forgeResponseSchema.parse(await invoke(github)(request));
    const forbidden = fakeGitHub(() => ({
      data: null,
      errors: [
        { type: 'FORBIDDEN', path: ['viewer'], message: 'Resource not accessible' },
        { type: 'FORBIDDEN', path: ['repository'], message: 'Resource not accessible' },
      ],
    }));
    expect(await run(forbidden)).toMatchObject({ ok: false, error: { kind: 'authorization' } });
    expect(forbidden.calls).toHaveLength(1);

    const limited = fakeGitHub(() => ({
      errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
    }));
    expect(await run(limited)).toMatchObject({ ok: false, error: { kind: 'rate_limited' } });
    expect(await run(fakeGitHub(() => ({}), 429))).toMatchObject({
      ok: false,
      error: { kind: 'rate_limited' },
    });

    const missing = fakeGitHub(() => document({ repository: null }));
    expect(await run(missing)).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  });
});
