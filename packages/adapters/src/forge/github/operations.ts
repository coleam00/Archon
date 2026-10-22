import {
  type ForgeError,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
  isMutationRequest,
  mutationTarget,
  mutationAttempt,
} from '@archon/forge/operations';
import { githubErrorDetail, parseRemote, type Fetch } from './api';
import { handleGithubChecksCommit, handleGithubChecksState } from './commit-checks';
import { handleGithubWorkItemComments } from './comments';
import { handleGithubPrMergeState } from './merge-state';
import { handleGithubMutation } from './lifecycle';
import { handleGithubPrReviews, handleGithubPrView } from './pull-requests';
import {
  handleGithubRepoLabelsList,
  handleGithubWorkItemList,
  handleGithubWorkItemView,
} from './workitems';
import { handleGithubPrThreads } from './review-threads';

export const githubPluginMetadata = {
  protocol: 1,
  name: 'github',
  version: '1',
  forge: 'github',
  hosts: ['github.com'],
  capabilities: [
    'resolve',
    'checks.state',
    'checks.commit',
    'workitem.view',
    'workitem.comments',
    'workitem.create',
    'workitem.labels.set',
    'workitem.label.add',
    'workitem.label.remove',
    'workitem.comment.upsert',
    'workitem.close',
    'workitem.edit-body',
    'workitem.list',
    'repo.labels.list',
    'repo.label.ensure',
    'pr.view',
    'pr.create',
    'pr.edit-body',
    'pr.ready',
    'pr.draft',
    'comment.upsert',
    'pr.merge',
    'checks.rerun',
    'pr.reviews',
    'pr.threads',
    'pr.merge-state',
    'pr.thread.reply',
    'pr.thread.resolve',
  ],
  mutationConditions: { 'pr.merge': ['head'] },
  token_env: ['GH_TOKEN', 'GITHUB_TOKEN'],
} satisfies PluginMetadata;

export interface GitHubOperationOptions {
  readonly token: string | undefined;
  readonly fetch?: Fetch;
}

function failure(operationId: string, error: ForgeError): ForgeResponse {
  return { operationId, ok: false, error };
}

export async function handleGithubOperation(
  request: ForgeRequest,
  options: GitHubOperationOptions
): Promise<ForgeResponse> {
  try {
    if (request.op === 'resolve') {
      const repo = parseRemote(request.remote);
      return {
        operationId: request.operationId,
        ok: true,
        result: {
          op: 'resolve',
          value: repo
            ? { kind: 'resolved', forge: 'github', repo, plugin: githubPluginMetadata }
            : { kind: 'none', forge: 'none' },
        },
      };
    }

    if (!options.token) {
      const error = {
        kind: 'no_credential' as const,
        message: 'ARCHON_FORGE_TOKEN is required for GitHub operations',
      };
      // A mutation refused for want of a credential never reached GitHub.
      return isMutationRequest(request)
        ? {
            operationId: request.operationId,
            ok: false,
            error,
            mutation: {
              op: request.op,
              target: mutationTarget(request),
              outcome: 'refused',
              ...mutationAttempt(request),
            },
          }
        : failure(request.operationId, error);
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const token = options.token;
    if (isMutationRequest(request)) return await handleGithubMutation(request, fetchImpl, token);
    if (request.op === 'workitem.view')
      return await handleGithubWorkItemView(request, fetchImpl, token);
    if (request.op === 'workitem.list')
      return await handleGithubWorkItemList(request, fetchImpl, token);
    if (request.op === 'repo.labels.list')
      return await handleGithubRepoLabelsList(request, fetchImpl, token);
    if (request.op === 'pr.reviews') return await handleGithubPrReviews(request, fetchImpl, token);
    if (request.op === 'pr.threads') return await handleGithubPrThreads(request, fetchImpl, token);
    if (request.op === 'pr.view') return await handleGithubPrView(request, fetchImpl, token);

    if (request.op === 'workitem.comments')
      return await handleGithubWorkItemComments(request, fetchImpl, token);
    if (request.op === 'pr.merge-state')
      return await handleGithubPrMergeState(request, fetchImpl, token);
    if (request.op === 'checks.commit')
      return await handleGithubChecksCommit(request, fetchImpl, token);
    return await handleGithubChecksState(request, fetchImpl, token);
  } catch (cause) {
    return failure(request.operationId, githubErrorDetail(cause));
  }
}
