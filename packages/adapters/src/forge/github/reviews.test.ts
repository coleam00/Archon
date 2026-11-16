import { describe, expect, test } from 'bun:test';
import { forgeResponseSchema, type ForgeRequest } from '@archon/forge/operations';
import { json, pull } from './lifecycle-fixture';
import { handleGithubOperation } from './operations';

const repo = { host: 'github.com', path: 'archon/test' };
const ref = { repo, number: 7 };
const API = 'https://api.github.com/repos/archon/test/pulls/7';
const user = { id: 2, login: 'author', type: 'User' };

interface Review {
  id: number;
  html_url: string;
  body: string;
  user: typeof user;
  commit_id: string;
  state: string;
  submitted_at: string;
}
interface Comment {
  id: number;
  pull_request_review_id: number;
  html_url: string;
  path: string;
  line: number;
  original_line: number;
  original_commit_id: string;
  body: string;
  user: typeof user;
  created_at: string;
  in_reply_to_id: null;
}

/**
 * A GitHub holding one pull request, its files, and the reviews and diff comments
 * posted to it, so a read sees what a submit wrote. `dropComments` loses the
 * inline comments of a submitted review.
 */
function reviewGitHub(options: { head?: string; dropComments?: boolean } = {}) {
  const reviews: Review[] = [];
  const comments: Comment[] = [];
  const posts: Record<string, unknown>[] = [];
  const head = options.head ?? 'commit-a';
  const files = [
    // New-side lines 9 to 12 are shown (9 context, 10 and 11 added, 12 context),
    // then 41 to 43 in a second hunk.
    {
      filename: 'src/a.ts',
      status: 'modified',
      patch:
        '@@ -9,3 +9,4 @@\n ctx\n-old\n+new\n+more\n ctx\n@@ -40,2 +41,3 @@\n ctx\n+added\n ctx',
    },
    { filename: 'logo.png', status: 'added' },
  ];
  const addReview = (
    review: Omit<Review, 'id' | 'html_url' | 'user' | 'state' | 'submitted_at'>
  ) => {
    const id = 100 + reviews.length;
    const stored = {
      id,
      html_url: `https://github.com/archon/test/pull/7#pullrequestreview-${String(id)}`,
      user,
      state: 'COMMENTED',
      submitted_at: '2026-11-16T10:00:00Z',
      ...review,
    };
    reviews.push(stored);
    return stored;
  };
  const addComment = (review: number, path: string, line: number, body: string) => {
    const id = 500 + comments.length;
    comments.push({
      id,
      pull_request_review_id: review,
      html_url: `https://github.com/archon/test/pull/7#discussion_r${String(id)}`,
      path,
      line,
      original_line: line,
      original_commit_id: head,
      body,
      user,
      created_at: '2026-11-16T10:00:00Z',
      in_reply_to_id: null,
    });
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(/[?&]per_page=100&page=\d+$/, '');
    const page = String(input).match(/page=(\d+)$/)?.[1];
    const pageOf = <T>(rows: T[]) => (page === undefined || page === '1' ? rows : []);
    if (url === API)
      return json({
        ...pull({ head: { ref: 'feature', sha: head, repo: { full_name: 'archon/test' } } }),
        changed_files: files.length,
      });
    if (url === `${API}/files`) return json(pageOf(files));
    if (url === `${API}/comments`) return json(pageOf(comments));
    if (url === `${API}/reviews` && init?.method === 'POST') {
      const sent = JSON.parse(String(init.body)) as {
        commit_id: string;
        body: string;
        comments: { path: string; line: number; body: string }[];
      };
      posts.push(sent);
      const review = addReview({ body: sent.body, commit_id: sent.commit_id });
      if (!options.dropComments)
        for (const comment of sent.comments)
          addComment(review.id, comment.path, comment.line, comment.body);
      return json(review);
    }
    if (url === `${API}/reviews`) return json(pageOf(reviews));
    const one = /\/reviews\/(\d+)$/.exec(url);
    if (one) return json(reviews.find(review => review.id === Number(one[1])));
    return json({ message: `unexpected ${url}` }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, reviews, comments, posts, addReview, addComment };
}

async function run(request: ForgeRequest, github: { fetch: typeof globalThis.fetch }) {
  return forgeResponseSchema.parse(
    await handleGithubOperation(request, { token: 'token', fetch: github.fetch })
  );
}

const submit = {
  operationId: 'review-1',
  op: 'pr.review.submit',
  ref,
  commit: 'commit-a',
  key: 'run-1',
  summary: 'Two findings.',
  comments: [
    { path: 'src/a.ts', line: 10, body: 'This line is new and wrong.' },
    { path: 'src/a.ts', line: 200, body: 'This line is not in the diff.' },
  ],
} satisfies ForgeRequest;

describe('pr.review.submit', () => {
  test('places in-diff findings inline, the rest in the summary, and pr.reviews tells it apart', async () => {
    const github = reviewGitHub();
    // A review the same account wrote by hand.
    const outside = github.addReview({ body: 'Looks fine to me.', commit_id: 'commit-a' });
    github.addComment(outside.id, 'src/a.ts', 11, 'A hand-written note.');

    const response = await run(submit, github);
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'pr.review.submit',
        value: {
          outcome: 'applied',
          changed: true,
          review: { ref, commit: 'commit-a', key: 'run-1' },
          comments: [
            { path: 'src/a.ts', line: 10, placed: 'inline' },
            { path: 'src/a.ts', line: 200, placed: 'summary' },
          ],
        },
      },
    });
    expect(github.posts).toEqual([
      {
        commit_id: 'commit-a',
        body: expect.stringContaining('Two findings.'),
        event: 'COMMENT',
        comments: [
          { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'This line is new and wrong.' },
        ],
      },
    ]);
    expect(github.posts[0]?.body).toContain('This line is not in the diff.');

    const read = await run({ operationId: 'reviews', op: 'pr.reviews', ref }, github);
    if (!read.ok || read.result.op !== 'pr.reviews') throw new Error(JSON.stringify(read));
    const items = read.result.value.items;
    const archon = items.filter(item => item.submitKey === 'run-1');
    expect(archon).toMatchObject([
      { kind: 'review', commit: 'commit-a', body: expect.stringContaining('Two findings.') },
      { kind: 'review_comment', body: 'This line is new and wrong.' },
    ]);
    expect(items.filter(item => item.submitKey === undefined).map(item => item.body)).toEqual([
      'Looks fine to me.',
      'A hand-written note.',
    ]);
  });

  test('a finding goes inline exactly on the lines a hunk shows', async () => {
    const github = reviewGitHub();
    const lines = [8, 9, 12, 13, 41, 42, 43, 44];
    const response = await run(
      {
        ...submit,
        comments: lines.map(line => ({ path: 'src/a.ts', line, body: `At ${String(line)}.` })),
      },
      github
    );
    if (!response.ok || response.result.op !== 'pr.review.submit')
      throw new Error(JSON.stringify(response));
    expect(response.result.value.comments.map(comment => comment.placed)).toEqual([
      'summary',
      'inline',
      'inline',
      'summary',
      'inline',
      'inline',
      'inline',
      'summary',
    ]);
  });

  test('a head other than the reviewed commit is refused before anything is written', async () => {
    const github = reviewGitHub({ head: 'commit-b' });
    expect(await run(submit, github)).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: {
        op: 'pr.review.submit',
        outcome: 'refused',
        observed: { head_revision: 'commit-b' },
      },
    });
    expect(github.posts).toEqual([]);
  });

  test('a repeat with the same key at the same commit posts one review', async () => {
    const github = reviewGitHub();
    const first = await run(submit, github);
    const second = await run({ ...submit, operationId: 'review-2' }, github);
    if (!first.ok || first.result.op !== 'pr.review.submit') throw new Error('first');
    expect(second).toMatchObject({
      ok: true,
      result: {
        value: {
          changed: false,
          review: { id: first.result.value.review.id },
          comments: [{ placed: 'inline' }, { placed: 'summary' }],
        },
      },
    });
    expect(github.posts).toHaveLength(1);
    expect(github.reviews).toHaveLength(1);
  });

  test('a repeat with the same key and commit but other findings is refused, not reported as placed', async () => {
    const github = reviewGitHub();
    await run(submit, github);
    const changed = {
      ...submit,
      operationId: 'review-2',
      comments: [...submit.comments, { path: 'src/a.ts', line: 300, body: 'A new finding.' }],
    };
    expect(await run(changed, github)).toMatchObject({
      ok: false,
      error: { kind: 'conflict', message: expect.stringContaining('Review 100') },
      mutation: { outcome: 'refused' },
    });
    expect(github.posts).toHaveLength(1);
  });

  test('a repeat naming one posted finding twice is refused, not matched to it twice', async () => {
    const github = reviewGitHub();
    const a = { path: 'src/a.ts', line: 10, body: 'Finding A.' };
    await run(
      { ...submit, comments: [a, { path: 'src/a.ts', line: 11, body: 'Finding B.' }] },
      github
    );
    expect(
      await run({ ...submit, operationId: 'review-2', comments: [a, a] }, github)
    ).toMatchObject({ ok: false, error: { kind: 'conflict' }, mutation: { outcome: 'refused' } });
    expect(github.posts).toHaveLength(1);
  });

  test('a review whose inline comments did not land is a verification failure naming it', async () => {
    const github = reviewGitHub({ dropComments: true });
    expect(await run(submit, github)).toMatchObject({
      ok: false,
      mutation: {
        outcome: 'verification_failed',
        leaveBehind: 'review 100 exists on the pull request',
      },
    });
  });
});
