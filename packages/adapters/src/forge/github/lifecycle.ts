/**
 * GitHub's work-item and pull-request lifecycle operations.
 *
 * Lifecycle mutations submit at most one write; check reruns submit one per run.
 * Each write is read back before claiming success. The outcome is decided by
 * how far the write got: nothing submitted is a refusal, a submitted request whose
 * answer was lost is unknown, and an acknowledged write whose read-back does not
 * agree is a verification failure carrying what may remain on the forge.
 */

import type { ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { GitHubError, githubErrorDetail, type Fetch } from './api';
import { handleGithubChecksRerun } from './checks-rerun';
import { refused, unknown, unverified, type Submit } from './mutation-outcome';
import { createPullRequest, editPullRequestBody, setDraftState } from './pull-requests';
import { mergePullRequest } from './merge';
import { upsertComment } from './comments';
import { replyOnThread, resolveThread } from './review-threads';
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
  token: string
): Promise<ForgeResponse> {
  if (request.op === 'checks.rerun') return handleGithubChecksRerun(request, fetchImpl, token);
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
    }
  } catch (cause) {
    const error = githubErrorDetail(cause);
    if (progress.phase === 'acknowledged')
      return unverified(request, error.message, 'the acknowledged write may remain');
    if (
      progress.phase === 'submitted' &&
      !(cause instanceof GitHubError && cause.definitiveRefusal)
    )
      return unknown(request, error);
    return refused(request, error);
  }
}
