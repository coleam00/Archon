import {
  PR_VIEW_ANY_STATE,
  RESOLVE_SUBJECT,
  type ForgeError,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
  isMutationRequest,
  mutationTarget,
  mutationAttempt,
} from '@archon/forge/operations';
import { githubErrorDetail, parseRemote, parseSubjectUrl, type Fetch, type Sleep } from './api';
import { handleGithubActorSelf } from './actor';
import { handleGithubChecksLogs } from './check-logs';
import { handleGithubChecksCommit, handleGithubChecksState } from './commit-checks';
import { handleGithubWorkItemComments } from './comments';
import { handleGithubPrFiles, handleGithubRepoFile } from './files';
import { handleGithubPrMergeState } from './merge-state';
import { handleGithubMutation } from './lifecycle';
import { handleGithubPrView } from './pull-requests';
import { handleGithubPrReviews } from './reviews';
import { handleGithubRepoOverview } from './repo-overview';
import {
  handleGithubRepoLabelsList,
  handleGithubWorkItemLabelAdded,
  handleGithubWorkItemList,
  handleGithubWorkItemOpened,
  handleGithubWorkItemView,
} from './workitems';
import { handleGithubPrThreads } from './review-threads';
import { handleGithubWorkItemSearch } from './search';

const GITHUB_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';

export const githubPluginMetadata = {
  protocol: 1,
  name: 'github',
  version: '1',
  forge: 'github',
  hosts: ['github.com'],
  capabilities: [
    'resolve',
    RESOLVE_SUBJECT,
    'checks.state',
    'checks.commit',
    'checks.logs',
    'workitem.view',
    'workitem.comments',
    'workitem.create',
    'workitem.labels.set',
    'workitem.label.add',
    'workitem.label.remove',
    'workitem.assignee.add',
    'workitem.assignee.remove',
    'workitem.comment.upsert',
    'workitem.close',
    'workitem.edit-body',
    'workitem.list',
    'workitem.label.added',
    'workitem.opened',
    'workitem.search',
    'repo.labels.list',
    'repo.label.ensure',
    'pr.view',
    PR_VIEW_ANY_STATE,
    'pr.create',
    'pr.edit-body',
    'pr.ready',
    'pr.draft',
    'pr.close',
    'comment.upsert',
    'pr.merge',
    'checks.rerun',
    'pr.reviews',
    'pr.threads',
    'pr.merge-state',
    'pr.files',
    'repo.file',
    'pr.thread.reply',
    'pr.thread.resolve',
    'pr.review.submit',
    'attachment.put',
    'actor.self',
    'repo.overview',
  ],
  display: { name: 'GitHub', icon: Buffer.from(GITHUB_MARK_SVG).toString('base64') },
  mutationConditions: { 'pr.merge': ['head'] },
  token_env: ['GH_TOKEN', 'GITHUB_TOKEN'],
  remedies: {
    unsupported_op:
      '`archon plugin update coleam00/Archon/plugins/forge-github` installs the latest ' +
      'released plugin, which may not support this operation either.',
    // Per-user GitHub mode scrubs the shared token from a run started by a user who has
    // not connected their own identity, so a shared `GH_TOKEN` cannot fix that refusal.
    no_credential:
      "Set `GH_TOKEN` in Archon's env file (`~/.archon/.env`, `ARCHON_HOME/.env` when " +
      'configured, or `/.archon/.env` in Docker), set `GITHUB_TOKEN`, use `gh auth login`, ' +
      'or configure GitHub App mode. When per-user GitHub is enabled, connect your own ' +
      'GitHub identity instead: `archon auth github` or the Web UI Settings page.',
  },
} satisfies PluginMetadata;

export interface GitHubOperationOptions {
  readonly token: string | undefined;
  readonly fetch?: Fetch;
  /** The wait inside a write's read-back; tests replace it so they do not sleep. */
  readonly sleep?: Sleep;
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
  'workitem.label.added': handleGithubWorkItemLabelAdded,
  'workitem.opened': handleGithubWorkItemOpened,
  'workitem.search': handleGithubWorkItemSearch,
  'workitem.comments': handleGithubWorkItemComments,
  'repo.labels.list': handleGithubRepoLabelsList,
  'pr.view': handleGithubPrView,
  'pr.reviews': handleGithubPrReviews,
  'pr.threads': handleGithubPrThreads,
  'pr.merge-state': handleGithubPrMergeState,
  'pr.files': handleGithubPrFiles,
  'repo.file': handleGithubRepoFile,
  'checks.state': handleGithubChecksState,
  'checks.commit': handleGithubChecksCommit,
  'checks.logs': handleGithubChecksLogs,
  'actor.self': handleGithubActorSelf,
  'repo.overview': handleGithubRepoOverview,
};

type ResolveValue = Extract<
  Extract<ForgeResponse, { ok: true }>['result'],
  { op: 'resolve' }
>['value'];

/** A Git remote's repository, or with `web` the issue or pull request a web URL names. */
function resolveGithub(remote: string | null, web: boolean): ResolveValue {
  const subject = web ? parseSubjectUrl(remote) : null;
  const repo = web ? subject?.repo : parseRemote(remote);
  if (!repo) return { kind: 'none', forge: 'none' };
  const resolved = {
    kind: 'resolved' as const,
    forge: 'github',
    repo,
    plugin: githubPluginMetadata,
  };
  return subject ? { ...resolved, subject: subject.subject } : resolved;
}

export async function handleGithubOperation(
  request: ForgeRequest,
  options: GitHubOperationOptions
): Promise<ForgeResponse> {
  try {
    if (request.op === 'resolve') {
      return {
        operationId: request.operationId,
        ok: true,
        result: { op: 'resolve', value: resolveGithub(request.remote, request.web === true) },
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
    const sleep = options.sleep ?? Bun.sleep;
    if (isMutationRequest(request))
      return await handleGithubMutation(request, fetchImpl, token, sleep);
    // Keyed by the request's own op, the handler takes that request; TypeScript cannot
    // correlate the table's members with the request union on its own.
    const read = readHandlers[request.op] as ReadHandler<ReadOp>;
    // A read that fails temporarily is repeated by the host, which records the repeats.
    return await read(request, fetchImpl, token);
  } catch (cause) {
    return failure(request.operationId, githubErrorDetail(cause));
  }
}
