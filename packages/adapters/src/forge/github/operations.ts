import {
  type ForgeError,
  type ForgeMutationRequest,
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

type ReadOp = Exclude<ForgeRequest['op'], 'resolve' | ForgeMutationRequest['op']>;
type ReadHandler<Op extends ReadOp> = (
  request: Extract<ForgeRequest, { op: Op }>,
  fetchImpl: Fetch,
  token: string
) => Promise<ForgeResponse>;

const readHandlers: { [Op in ReadOp]: ReadHandler<Op> } = {
  'workitem.view': handleGithubWorkItemView,
  'workitem.list': handleGithubWorkItemList,
  'workitem.comments': handleGithubWorkItemComments,
  'repo.labels.list': handleGithubRepoLabelsList,
  'pr.view': handleGithubPrView,
  'pr.reviews': handleGithubPrReviews,
  'pr.threads': handleGithubPrThreads,
  'pr.merge-state': handleGithubPrMergeState,
  'checks.state': handleGithubChecksState,
  'checks.commit': handleGithubChecksCommit,
};

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
    // Keyed by the request's own op, the handler takes that request; TypeScript cannot
    // correlate the table's members with the request union on its own.
    const read = readHandlers[request.op] as ReadHandler<ReadOp>;
    return await read(request, fetchImpl, token);
  } catch (cause) {
    return failure(request.operationId, githubErrorDetail(cause));
  }
}
