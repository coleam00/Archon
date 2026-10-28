/**
 * Conversation comments on a GitHub issue or pull request: the canonical marked
 * comment, written in place, and the read of every comment with its author.
 */

import { z } from 'zod';
import {
  contentDigest,
  type ForgeCommentRecord,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import type { PrRef } from '@archon/forge';
import { githubPages, githubRequest, location, type Fetch } from './api';
import { applied, refused, unverified, type Submit } from './mutation-outcome';
import { readIssue, subjectRecord } from './workitems';
import { actor, userSchema } from './actor';

const commentSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  html_url: z.url(),
  issue_url: z.url(),
  body: z.string().nullable(),
  user: userSchema.optional(),
});
type Comment = z.infer<typeof commentSchema>;

function commentRecord(ref: PrRef, comment: Comment): ForgeCommentRecord {
  return {
    ref,
    id: String(comment.id),
    url: comment.html_url,
    bodyDigest: contentDigest(comment.body ?? ''),
  };
}

export async function upsertComment(
  request: Extract<ForgeMutationRequest, { op: 'comment.upsert' | 'workitem.comment.upsert' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  // The marker is how the canonical comment is found again next round, so a body
  // that does not carry it would silently create a second report.
  if ((request.body.split(/\r?\n/, 1)[0] ?? '') !== request.marker) {
    return refused(request, {
      kind: 'invalid_request',
      message: 'Comment body must begin with the exact canonical marker',
    });
  }
  const ref = request.op === 'comment.upsert' ? request.ref : request.subject.ref;
  // GitHub serves issue and pull-request comments from one endpoint, so a subject's
  // kind is proved against the item before anything is written to it.
  const subject =
    request.op === 'workitem.comment.upsert'
      ? { workitem: subjectRecord(request.subject, await readIssue(fetchImpl, token, ref)) }
      : {};
  const { root, path } = location(ref.repo);
  const issue = `${root}/repos/${path}/issues/${String(ref.number)}`;
  const comments = await githubPages(fetchImpl, token, `${issue}/comments`, raw =>
    z.array(commentSchema).parse(raw)
  );
  const marked = comments.filter(
    comment => (comment.body ?? '').split(/\r?\n/, 1)[0] === request.marker
  );
  if (marked.length > 1) {
    return refused(request, {
      kind: 'conflict',
      message: 'Multiple comments on this item carry the canonical marker',
    });
  }
  const previous = marked[0];
  if (previous && (previous.body ?? '') === request.body) {
    // The listing is the read-back: the canonical comment already carries this body.
    return applied(request, {
      changed: false,
      ...subject,
      comment: commentRecord(ref, previous),
    });
  }
  submit('submitted');
  const raw = await githubRequest(
    fetchImpl,
    token,
    previous ? `${root}/repos/${path}/issues/comments/${String(previous.id)}` : `${issue}/comments`,
    { method: previous ? 'PATCH' : 'POST', body: JSON.stringify({ body: request.body }) },
    () => {
      submit('acknowledged');
    }
  );
  let written: Comment;
  try {
    written = commentSchema.parse(raw);
  } catch {
    return unverified(
      request,
      'Comment write response was malformed',
      'a comment may have changed',
      subject
    );
  }
  const leaveBehind = `comment ${String(written.id)} may have changed`;
  let observed: Comment;
  try {
    observed = commentSchema.parse(
      await githubRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/issues/comments/${String(written.id)}`
      )
    );
  } catch {
    return unverified(request, 'Comment could not be read back', leaveBehind, subject);
  }
  const comment = commentRecord(ref, observed);
  if (
    String(observed.id) !== String(written.id) ||
    // GitHub echoes owner/name in its registered case (see sameRepo).
    observed.issue_url.toLowerCase() !== issue.toLowerCase() ||
    (observed.body ?? '') !== request.body
  ) {
    return unverified(request, 'Comment read-back did not match', leaveBehind, {
      ...subject,
      comment,
    });
  }
  return applied(request, { changed: true, ...subject, comment });
}

export async function handleGithubWorkItemComments(
  request: Extract<ForgeRequest, { op: 'workitem.comments' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { ref } = request.subject;
  // One endpoint serves issue and pull-request comments, so the kind is proved first.
  const workitem = subjectRecord(request.subject, await readIssue(fetchImpl, token, ref));
  const { root, path } = location(ref.repo);
  const comments = await githubPages(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues/${String(ref.number)}/comments`,
    raw => z.array(commentSchema).parse(raw)
  );
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'workitem.comments',
      value: {
        workitem,
        comments: comments.map(comment => ({
          id: String(comment.id),
          author: actor(ref.repo.host, comment.user ?? null),
          url: comment.html_url,
          body: comment.body ?? '',
        })),
      },
    },
  };
}
