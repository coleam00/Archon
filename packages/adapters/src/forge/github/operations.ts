import { z } from 'zod';
import { checkPhase, checkResult } from './normalize-event';
import {
  type CheckObservation,
  type ForgeError,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
  concludedCheckStates,
  summarizeChecks,
} from '@archon/forge/operations';

export const githubPluginMetadata = {
  protocol: 1,
  name: 'github',
  version: '1',
  forge: 'github',
  hosts: ['github.com'],
  capabilities: ['resolve', 'checks.state'],
  token_env: ['GH_TOKEN', 'GITHUB_TOKEN'],
} satisfies PluginMetadata;

export interface GitHubOperationOptions {
  readonly token: string | undefined;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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

class GitHubOperationError extends Error {
  constructor(
    readonly error: ForgeError,
    options?: ErrorOptions
  ) {
    super(error.message, options);
  }
}

function failure(operationId: string, error: ForgeError): ForgeResponse {
  return { operationId, ok: false, error };
}

function repositoryPath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts.some(part => part === '' || part === '.' || part === '..')) {
    return null;
  }
  const owner = parts[0];
  const repo = parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1];
  return owner && repo ? { owner, repo } : null;
}

function parseRemote(remote: string | null): { host: string; path: string } | null {
  if (remote === null || remote.trim() === '') return null;
  const value = remote.trim();

  if (value.includes('://')) {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause) {
      throw new GitHubOperationError(
        { kind: 'invalid_request', message: 'GitHub remote is not a valid URL' },
        { cause }
      );
    }
    if (!['https:', 'ssh:'].includes(url.protocol)) return null;
    if (url.password !== '' || (url.protocol === 'https:' && url.username !== '')) {
      throw new GitHubOperationError({
        kind: 'invalid_request',
        message: 'GitHub remote must not contain credentials',
      });
    }
    if (url.search !== '' || url.hash !== '') {
      throw new GitHubOperationError({
        kind: 'invalid_request',
        message: 'GitHub remote must not contain a query or fragment',
      });
    }
    const repository = repositoryPath(decodeURIComponent(url.pathname));
    if (!repository) return null;
    return { host: url.host.toLowerCase(), path: `${repository.owner}/${repository.repo}` };
  }

  // Git's SCP-like SSH form has no URL scheme. Its optional user is transport identity,
  // not an HTTP credential, and is deliberately discarded at this normalization boundary.
  const match = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
  if (!match) return null;
  const repository = repositoryPath(match[2]);
  if (!repository) return null;
  return { host: match[1].toLowerCase(), path: `${repository.owner}/${repository.repo}` };
}

function apiRoot(host: string): string {
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch (cause) {
    throw new GitHubOperationError(
      { kind: 'invalid_request', message: `Invalid GitHub host: ${host}` },
      { cause }
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new GitHubOperationError({
      kind: 'invalid_request',
      message: `Invalid GitHub host: ${host}`,
    });
  }
  return parsed.hostname.toLowerCase() === 'github.com'
    ? 'https://api.github.com'
    : `https://${parsed.host}/api/v3`;
}

async function githubJson(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  token: string,
  url: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'archon-forge-github',
      },
    });
  } catch (cause) {
    throw new GitHubOperationError(
      { kind: 'forge_error', message: 'GitHub API request failed' },
      { cause }
    );
  }
  if (!response.ok) {
    throw new GitHubOperationError({
      kind: response.status === 404 ? 'not_found' : 'forge_error',
      message: `GitHub API request failed with HTTP ${String(response.status)}`,
      status: response.status,
    });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new GitHubOperationError(
      { kind: 'forge_error', message: 'GitHub API returned invalid JSON' },
      { cause }
    );
  }
}

async function paginated<T>(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  token: string,
  baseUrl: string,
  readPage: (value: unknown) => readonly T[]
): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; ; page++) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const rows = readPage(
      await githubJson(fetchImpl, token, `${baseUrl}${separator}per_page=100&page=${String(page)}`)
    );
    values.push(...rows);
    if (rows.length < 100) return values;
  }
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
      return failure(request.operationId, {
        kind: 'no_credential',
        message: 'ARCHON_FORGE_TOKEN is required for GitHub operations',
      });
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const repository = repositoryPath(request.ref.repo.path);
    if (!repository) {
      return failure(request.operationId, {
        kind: 'invalid_request',
        message: `Invalid GitHub repository path: ${request.ref.repo.path}`,
      });
    }
    const root = apiRoot(request.ref.repo.host);
    const path = `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
    const pull = pullRequestSchema.parse(
      await githubJson(
        fetchImpl,
        options.token,
        `${root}/repos/${path}/pulls/${String(request.ref.number)}`
      )
    );
    const revision = pull.head.sha;
    const ref = encodeURIComponent(revision);
    const [runs, allStatuses] = await Promise.all([
      paginated(
        fetchImpl,
        options.token,
        `${root}/repos/${path}/commits/${ref}/check-runs?filter=latest`,
        value => checkRunsPageSchema.parse(value).check_runs
      ),
      paginated(fetchImpl, options.token, `${root}/repos/${path}/commits/${ref}/statuses`, value =>
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
    if (cause instanceof GitHubOperationError) return failure(request.operationId, cause.error);
    if (cause instanceof z.ZodError) {
      return failure(request.operationId, {
        kind: 'forge_error',
        message: `GitHub API response did not match its documented shape: ${cause.issues[0]?.message ?? 'invalid response'}`,
      });
    }
    return failure(request.operationId, {
      kind: 'forge_error',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
