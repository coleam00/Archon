/**
 * Pull-request reviews on GitHub: the read of every review and diff comment, and
 * the comment-kind review `pr.review.submit` posts.
 *
 * A submitted review is presentation; nothing gates on it. GitHub reviews have no
 * metadata field, so the plugin carries the contract's `submitKey` as an HTML
 * comment on the review body's first line, which GitHub does not render. This
 * module is the only writer and reader of that line.
 */

import { z } from 'zod';
import {
  contentDigest,
  reviewItemSchema,
  reviewKeySchema,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import type { PrRef } from '@archon/forge';
import { githubPages, githubRequest, location, type Fetch } from './api';
import { actor, userSchema } from './actor';
import { readPullFiles } from './files';
import { applied, refused, unverified, type Submit } from './mutation-outcome';
import { prRecord, readPull } from './pull-requests';

type SubmitRequest = Extract<ForgeMutationRequest, { op: 'pr.review.submit' }>;
type Placed = 'inline' | 'summary';

const fields = reviewItemSchema.shape;
const itemSchema = z.object({
  id: z.union([z.number().int(), fields.id]),
  html_url: fields.url,
  body: fields.body.nullable(),
  user: userSchema,
  commit_id: fields.commit.optional(),
  state: fields.state.optional(),
  submitted_at: fields.createdAt.optional(),
  created_at: fields.createdAt.optional(),
  in_reply_to_id: z.number().nullable().optional(),
  pull_request_review_id: z.number().int().nullable().optional(),
});
type Item = z.infer<typeof itemSchema>;
// A review comment's line on the file at the commit it was made on; `line` turns
// null once the head moves past it.
const diffCommentSchema = itemSchema.extend({
  path: z.string(),
  original_line: z.number().int().nullable().optional(),
});
type DiffComment = z.infer<typeof diffCommentSchema>;

const MARKER_PREFIX = '<!-- archon-review-key: ';
const MARKER_SUFFIX = ' -->';

function reviewMarker(key: string): string {
  return `${MARKER_PREFIX}${key}${MARKER_SUFFIX}`;
}

/** The key on a body's first line, when that line is exactly a marker. */
function markerKey(body: string | null): string | undefined {
  const first = (body ?? '').split(/\r?\n/, 1)[0] ?? '';
  if (!first.startsWith(MARKER_PREFIX) || !first.endsWith(MARKER_SUFFIX)) return undefined;
  const key = reviewKeySchema.safeParse(first.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length));
  return key.success ? key.data : undefined;
}

function pullUrl(ref: PrRef): string {
  const { root, path } = location(ref.repo);
  return `${root}/repos/${path}/pulls/${String(ref.number)}`;
}

async function readReviews(fetchImpl: Fetch, token: string, ref: PrRef): Promise<Item[]> {
  return githubPages(fetchImpl, token, `${pullUrl(ref)}/reviews`, value =>
    z.array(itemSchema).parse(value)
  );
}

async function readDiffComments(
  fetchImpl: Fetch,
  token: string,
  ref: PrRef
): Promise<DiffComment[]> {
  return githubPages(fetchImpl, token, `${pullUrl(ref)}/comments`, value =>
    z.array(diffCommentSchema).parse(value)
  );
}

export async function handleGithubPrReviews(
  request: Extract<ForgeRequest, { op: 'pr.reviews' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const [reviews, comments] = await Promise.all([
    readReviews(fetchImpl, token, request.ref),
    githubPages(fetchImpl, token, `${pullUrl(request.ref)}/comments`, value =>
      z.array(itemSchema).parse(value)
    ),
  ]);
  const submitted = reviews.filter(item => item.state !== 'PENDING');
  const keys = new Map<string, string>();
  for (const review of submitted) {
    const key = markerKey(review.body);
    if (key !== undefined) keys.set(String(review.id), key);
  }
  const project = (
    item: Item,
    kind: 'review' | 'review_comment',
    submitKey: string | undefined
  ): z.infer<typeof reviewItemSchema> => ({
    kind,
    id: String(item.id),
    author: actor(request.ref.repo.host, item.user),
    commit: item.commit_id ?? null,
    state: kind === 'review' ? (item.state ?? null) : null,
    createdAt: (kind === 'review' ? item.submitted_at : item.created_at) ?? null,
    url: item.html_url,
    body: item.body ?? '',
    ...(submitKey === undefined ? {} : { submitKey }),
  });
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: {
        ref: request.ref,
        items: [
          ...submitted.map(item => project(item, 'review', keys.get(String(item.id)))),
          ...comments
            .filter(item => item.in_reply_to_id == null)
            .map(item =>
              project(
                item,
                'review_comment',
                item.pull_request_review_id == null
                  ? undefined
                  : keys.get(String(item.pull_request_review_id))
              )
            ),
        ],
      },
    },
  };
}

/** The new-side lines a unified diff shows, added or context, which GitHub accepts a comment on. */
function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let next: number | undefined;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === undefined || row.startsWith('-') || row.startsWith('\\')) continue;
    lines.add(next);
    next++;
  }
  return lines;
}

function composeBody(request: SubmitRequest, placed: readonly Placed[]): string {
  const elsewhere = request.comments.filter((_, index) => placed[index] === 'summary');
  const sections = [`${reviewMarker(request.key)}\n${request.summary}`];
  if (elsewhere.length > 0) {
    sections.push('### Findings not on a changed line');
    for (const comment of elsewhere)
      sections.push(`**\`${comment.path}\`, line ${String(comment.line)}**\n\n${comment.body}`);
  }
  return sections.join('\n\n');
}

/** Where each request comment is, read back from the review's own diff comments. */
function observedPlacement(request: SubmitRequest, comments: readonly DiffComment[]): Placed[] {
  return request.comments.map(wanted =>
    comments.some(
      comment =>
        comment.path === wanted.path &&
        comment.original_line === wanted.line &&
        comment.body === wanted.body
    )
      ? 'inline'
      : 'summary'
  );
}

function submitResult(request: SubmitRequest, review: Item, placed: readonly Placed[]): object {
  return {
    review: {
      ref: request.ref,
      id: String(review.id),
      url: review.html_url,
      commit: request.commit,
      key: request.key,
      bodyDigest: contentDigest(review.body ?? ''),
    },
    comments: request.comments.map((comment, index) => ({
      path: comment.path,
      line: comment.line,
      placed: placed[index],
    })),
  };
}

async function reviewComments(
  fetchImpl: Fetch,
  token: string,
  ref: PrRef,
  review: Item
): Promise<DiffComment[]> {
  const comments = await readDiffComments(fetchImpl, token, ref);
  return comments.filter(comment => comment.pull_request_review_id === Number(review.id));
}

export async function submitReview(
  request: SubmitRequest,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const pull = await readPull(fetchImpl, token, request.ref);
  const headMoved = (head: string) =>
    refused(
      request,
      {
        kind: 'conflict',
        message: `Pull request ${String(request.ref.number)}'s head is ${head}, not the reviewed commit ${request.commit}`,
      },
      prRecord(request.ref.repo, pull)
    );
  if (pull.head.sha !== request.commit) return headMoved(pull.head.sha);

  const posted = (await readReviews(fetchImpl, token, request.ref)).filter(
    review =>
      review.state !== 'PENDING' &&
      review.commit_id === request.commit &&
      markerKey(review.body) === request.key
  );
  if (posted.length > 1)
    return refused(request, {
      kind: 'conflict',
      message: `More than one review on this pull request carries key ${request.key} at ${request.commit}`,
    });
  const previous = posted[0];
  if (previous) {
    const comments = await reviewComments(fetchImpl, token, request.ref, previous);
    return applied(request, {
      changed: false,
      ...submitResult(request, previous, observedPlacement(request, comments)),
    });
  }

  const { head, files } = await readPullFiles(fetchImpl, token, request.ref);
  if (head !== request.commit) return headMoved(head);
  const shown = new Map(
    files.flatMap(file =>
      file.patch === null ? [] : [[file.path, commentableLines(file.patch)] as const]
    )
  );
  const placed: Placed[] = request.comments.map(comment =>
    shown.get(comment.path)?.has(comment.line) ? 'inline' : 'summary'
  );
  const body = composeBody(request, placed);

  submit('submitted');
  const raw = await githubRequest(
    fetchImpl,
    token,
    `${pullUrl(request.ref)}/reviews`,
    {
      method: 'POST',
      body: JSON.stringify({
        commit_id: request.commit,
        body,
        event: 'COMMENT',
        comments: request.comments
          .filter((_, index) => placed[index] === 'inline')
          .map(comment => ({
            path: comment.path,
            line: comment.line,
            side: 'RIGHT',
            body: comment.body,
          })),
      }),
    },
    () => {
      submit('acknowledged');
    }
  );
  const written = itemSchema.safeParse(raw);
  if (!written.success)
    return unverified(
      request,
      'Review submit response was malformed',
      'a review may have been posted'
    );
  const leaveBehind = `review ${String(written.data.id)} exists on the pull request`;
  let review: Item;
  let comments: DiffComment[];
  try {
    review = itemSchema.parse(
      await githubRequest(
        fetchImpl,
        token,
        `${pullUrl(request.ref)}/reviews/${String(written.data.id)}`
      )
    );
    comments = await reviewComments(fetchImpl, token, request.ref, review);
  } catch {
    return unverified(request, 'Review could not be read back', leaveBehind);
  }
  const observed = observedPlacement(request, comments);
  const inline = placed.filter(where => where === 'inline').length;
  if (
    String(review.id) !== String(written.data.id) ||
    review.commit_id !== request.commit ||
    (review.body ?? '') !== body ||
    comments.length !== inline ||
    observed.some((where, index) => where !== placed[index])
  )
    return unverified(request, 'Review read-back did not match', leaveBehind);
  return applied(request, { changed: true, ...submitResult(request, review, placed) });
}
