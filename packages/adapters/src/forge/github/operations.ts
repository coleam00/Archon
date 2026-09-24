import { z } from 'zod';
import { checkPhase, checkResult } from './normalize-event';
import {
  type CheckObservation,
  type ForgeError,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
  concludedCheckStates,
  isMutationRequest,
  mutationTarget,
  summarizeChecks,
} from '@archon/forge/operations';
import {
  githubErrorDetail,
  githubPages,
  githubRequest,
  location,
  parseRemote,
  type Fetch,
} from './api';
import { handleGithubMutation, handleGithubPrView, handleGithubWorkItemView } from './lifecycle';

export const githubPluginMetadata = {
  protocol: 1,
  name: 'github',
  version: '1',
  forge: 'github',
  hosts: ['github.com'],
  capabilities: [
    'resolve',
    'checks.state',
    'workitem.view',
    'pr.view',
    'pr.create',
    'pr.edit-body',
    'pr.ready',
    'comment.upsert',
  ],
  token_env: ['GH_TOKEN', 'GITHUB_TOKEN'],
} satisfies PluginMetadata;

export interface GitHubOperationOptions {
  readonly token: string | undefined;
  readonly fetch?: Fetch;
}

const pullRequestSchema = z.object({ head: z.object({ sha: z.string().min(1) }) });
const checkRunSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable().optional(),
});
const checkRunsPageSchema = z.object({ check_runs: z.array(checkRunSchema) });
const statusSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  context: z.string().min(1),
  state: z.string().min(1),
});
const statusesPageSchema = z.array(statusSchema);

function failure(operationId: string, error: ForgeError): ForgeResponse {
  return { operationId, ok: false, error };
}

function checkRunObservation(run: z.infer<typeof checkRunSchema>): CheckObservation {
  const nativeResult = run.conclusion ?? null;
  const normalizedResult = checkResult(nativeResult);
  if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending') {
    return {
      unit: { kind: 'check', id: String(run.id), name: run.name },
      nativeState: run.status,
      phase: checkPhase(run.status),
      nativeResult,
      result: normalizedResult,
      state: 'pending',
    };
  }
  if (run.status === 'in_progress') {
    return {
      unit: { kind: 'check', id: String(run.id), name: run.name },
      nativeState: run.status,
      phase: checkPhase(run.status),
      nativeResult,
      result: normalizedResult,
      state: 'pending',
    };
  }
  const state =
    run.status !== 'completed' || normalizedResult === null
      ? 'unknown'
      : concludedCheckStates[normalizedResult];
  return {
    unit: { kind: 'check', id: String(run.id), name: run.name },
    nativeState: run.status,
    phase: checkPhase(run.status),
    nativeResult,
    result: normalizedResult,
    state,
  };
}

function statusObservation(status: z.infer<typeof statusSchema>): CheckObservation {
  const state =
    status.state === 'pending'
      ? 'pending'
      : status.state === 'success'
        ? 'green'
        : status.state === 'failure' || status.state === 'error'
          ? 'red'
          : 'unknown';
  return {
    unit: { kind: 'commit_status', id: String(status.id), name: status.context },
    nativeState: status.state,
    phase: checkPhase(status.state),
    nativeResult: status.state,
    result:
      status.state === 'pending'
        ? null
        : checkResult(status.state === 'error' ? 'failure' : status.state),
    state,
  };
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
            mutation: { op: request.op, target: mutationTarget(request), outcome: 'refused' },
          }
        : failure(request.operationId, error);
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const token = options.token;
    if (isMutationRequest(request)) return await handleGithubMutation(request, fetchImpl, token);
    if (request.op === 'workitem.view')
      return await handleGithubWorkItemView(request, fetchImpl, token);
    if (request.op === 'pr.view') return await handleGithubPrView(request, fetchImpl, token);

    const { root, path } = location(request.ref.repo);
    const pull = pullRequestSchema.parse(
      await githubRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/pulls/${String(request.ref.number)}`
      )
    );
    const revision = pull.head.sha;
    const ref = encodeURIComponent(revision);
    const [runs, allStatuses] = await Promise.all([
      githubPages(
        fetchImpl,
        token,
        `${root}/repos/${path}/commits/${ref}/check-runs?filter=latest`,
        value => checkRunsPageSchema.parse(value).check_runs
      ),
      githubPages(fetchImpl, token, `${root}/repos/${path}/commits/${ref}/statuses`, value =>
        statusesPageSchema.parse(value)
      ),
    ]);
    // GitHub returns statuses newest first. Context names are case-insensitive, so the
    // first row for each folded context is the authoritative latest status unit.
    const contexts = new Set<string>();
    const statuses = allStatuses.filter(status => {
      const context = status.context.toLowerCase();
      if (contexts.has(context)) return false;
      contexts.add(context);
      return true;
    });
    const units = [...runs.map(checkRunObservation), ...statuses.map(statusObservation)];
    return {
      operationId: request.operationId,
      ok: true,
      result: {
        op: 'checks.state',
        value: {
          ref: request.ref,
          revision,
          units,
          summary: summarizeChecks(units),
          // The check-runs and statuses APIs enumerate observations but do not say which
          // checks branch protection requires. Returning null keeps that absence explicit.
          required: null,
        },
      },
    };
  } catch (cause) {
    return failure(request.operationId, githubErrorDetail(cause));
  }
}
