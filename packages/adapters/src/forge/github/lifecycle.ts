/**
 * GitHub's work-item and pull-request lifecycle operations.
 *
 * Lifecycle mutations submit at most one write; check reruns submit one per run.
 * Each write is read back before claiming success; a rerun's read-back repeats for a
 * short bounded time, because GitHub reports the newer attempt late. The outcome is decided by
 * how far the write got: nothing submitted is a refusal, a submitted request whose
 * answer was lost is unknown, and an acknowledged write whose read-back does not
 * agree is a verification failure carrying what may remain on the forge.
 */

import type { ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { GitHubError, githubErrorDetail, type Fetch, type Sleep } from './api';
import { handleGithubChecksRerun } from './checks-rerun';
import { refused, unknown, unreadable, type Submit } from './mutation-outcome';
import {
  closePullRequest,
  createPullRequest,
  editPullRequestBody,
  setDraftState,
} from './pull-requests';
import { mergePullRequest } from './merge';
import { upsertComment } from './comments';
import { replyOnThread, resolveThread } from './review-threads';
import { submitReview } from './reviews';
import { putAttachment } from './attachments';
import {
  addLabel,
  closeWorkItem,
  createWorkItem,
  editWorkItemBody,
  ensureLabel,
  removeLabel,
  setLabels,
} from './workitems';

export async function handleGithubMutation(
  request: ForgeMutationRequest,
  fetchImpl: Fetch,
  token: string,
  sleep: Sleep
): Promise<ForgeResponse> {
  if (request.op === 'checks.rerun')
    return handleGithubChecksRerun(request, fetchImpl, token, sleep);
  const progress: { phase: 'not_submitted' | 'submitted' | 'acknowledged' } = {
    phase: 'not_submitted',
  };
  const submit: Submit = next => {
    progress.phase = next;
  };
  try {
    switch (request.op) {
      case 'workitem.create':
        return await createWorkItem(request, fetchImpl, token, submit);
      case 'workitem.labels.set':
        return await setLabels(request, fetchImpl, token, submit);
      case 'workitem.label.add':
        return await addLabel(request, fetchImpl, token, submit);
      case 'workitem.label.remove':
        return await removeLabel(request, fetchImpl, token, submit);
      case 'repo.label.ensure':
        return await ensureLabel(request, fetchImpl, token, submit);
      case 'pr.merge':
        return await mergePullRequest(request, fetchImpl, token, submit);
      case 'pr.create':
        return await createPullRequest(request, fetchImpl, token, submit);
      case 'pr.edit-body':
        return await editPullRequestBody(request, fetchImpl, token, submit);
      case 'pr.ready':
      case 'pr.draft':
        return await setDraftState(request, fetchImpl, token, submit);
      case 'pr.close':
        return await closePullRequest(request, fetchImpl, token, submit);
      case 'comment.upsert':
      case 'workitem.comment.upsert':
        return await upsertComment(request, fetchImpl, token, submit);
      case 'workitem.close':
        return await closeWorkItem(request, fetchImpl, token, submit);
      case 'workitem.edit-body':
        return await editWorkItemBody(request, fetchImpl, token, submit);
      case 'pr.thread.reply':
        return await replyOnThread(request, fetchImpl, token, submit);
      case 'pr.thread.resolve':
        return await resolveThread(request, fetchImpl, token, submit);
      case 'pr.review.submit':
        return await submitReview(request, fetchImpl, token, submit);
      case 'attachment.put':
        return await putAttachment(request, fetchImpl, token, submit);
    }
  } catch (cause) {
    // An acknowledged write whose read-back has no catch of its own lands here.
    if (progress.phase === 'acknowledged')
      return unreadable(
        request,
        'The acknowledged write could not be confirmed',
        cause,
        'the acknowledged write may remain'
      );
    const error = githubErrorDetail(cause);
    if (
      progress.phase === 'submitted' &&
      !(cause instanceof GitHubError && cause.definitiveRefusal)
    )
      return unknown(request, error);
    return refused(request, error);
  }
}
