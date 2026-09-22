import { createHash } from 'node:crypto';
import { z } from 'zod';
import { checkPhase, checkResult } from './normalize-event';
import {
  forgePrRecordSchema,
  forgeResponseSchema,
  isMutationRequest,
  landedCommitSchema,
  mutationEvidence,
  summarizeChecks,
  type CheckObservation,
  type ForgeError,
  type ForgeMutationFailure,
  type ForgeMutationRequest,
  type ForgePrRecord,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
} from '@archon/forge/operations';
import type { RepoRef } from '@archon/forge';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
    'pr.merge',
  ],
  operations: {
    'pr.merge': {
      methods: ['merge', 'squash', 'rebase'],
      atomicConditions: ['head'],
      readback: ['commit', 'tree', 'parents'],
    },
  },
  token_env: ['GH_TOKEN', 'GITHUB_TOKEN'],
} satisfies PluginMetadata;

export interface GitHubOperationOptions {
  readonly token: string | undefined;
  readonly fetch?: Fetch;
}
const repoSchema = z.object({ full_name: z.string().min(1) });
const pullSchema = z.object({
  number: z.number().int().positive(),
  node_id: z.string().min(1),
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged: z.boolean().optional(),
  maintainer_can_modify: z.boolean().nullable().optional(),
  head: z.object({ ref: z.string().min(1), sha: z.string().min(1), repo: repoSchema.nullable() }),
  base: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
});
type Pull = z.infer<typeof pullSchema>;
const issueSchema = z.object({
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  pull_request: z.unknown().optional(),
});
const commentSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  html_url: z.url(),
  issue_url: z.url(),
  body: z.string().nullable(),
});
const mergeSchema = z.object({
  merged: z.boolean(),
  sha: z.string().nullable().optional(),
  message: z.string().optional(),
});
const commitSchema = z.object({
  sha: z.string().min(1),
  tree: z.object({ sha: z.string().min(1) }),
  parents: z.array(z.object({ sha: z.string().min(1) })),
});
const checkSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable().optional(),
});
const statusSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]),
  context: z.string().min(1),
  state: z.string().min(1),
});

class GitHubError extends Error {
  constructor(
    readonly detail: ForgeError,
    readonly definitiveRefusal = false
  ) {
    super(detail.message);
  }
}
function fail(
  operationId: string,
  error: ForgeError,
  mutation?: ForgeMutationFailure
): ForgeResponse {
  return mutation ? { operationId, ok: false, error, mutation } : { operationId, ok: false, error };
}
function repositoryPath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..')) return null;
  const repo = parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1];
  return repo ? { owner: parts[0], repo } : null;
}
function parseRemote(remote: string | null): RepoRef | null {
  if (!remote?.trim()) return null;
  const value = remote.trim();
  if (value.includes('://')) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new GitHubError({
        kind: 'invalid_request',
        message: 'GitHub remote is not a valid URL',
      });
    }
    if (!['https:', 'ssh:'].includes(url.protocol)) return null;
    if (url.password || (url.protocol === 'https:' && url.username))
      throw new GitHubError({
        kind: 'invalid_request',
        message: 'GitHub remote must not contain credentials',
      });
    if (url.search || url.hash)
      throw new GitHubError({
        kind: 'invalid_request',
        message: 'GitHub remote must not contain a query or fragment',
      });
    const repo = repositoryPath(decodeURIComponent(url.pathname));
    return repo ? { host: url.host.toLowerCase(), path: `${repo.owner}/${repo.repo}` } : null;
  }
  const match = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
  const repo = match ? repositoryPath(match[2]) : null;
  return match && repo
    ? { host: match[1].toLowerCase(), path: `${repo.owner}/${repo.repo}` }
    : null;
}
function apiRoot(host: string): string {
  const url = new URL(`https://${host}`);
  if (url.pathname !== '/' || url.username || url.password || url.search || url.hash)
    throw new GitHubError({ kind: 'invalid_request', message: `Invalid GitHub host: ${host}` });
  return url.hostname === 'github.com' ? 'https://api.github.com' : `https://${url.host}/api/v3`;
}
function location(repo: RepoRef): { root: string; path: string } {
  const parsed = repositoryPath(repo.path);
  if (!parsed)
    throw new GitHubError({
      kind: 'invalid_request',
      message: `Invalid GitHub repository path: ${repo.path}`,
    });
  return {
    root: apiRoot(repo.host),
    path: `${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
  };
}
async function request(
  fetchImpl: Fetch,
  token: string,
  url: string,
  init: RequestInit = {},
  acknowledge?: () => void
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'archon-forge-github',
      },
    });
  } catch {
    throw new GitHubError({ kind: 'forge_error', message: 'GitHub API request failed' });
  }
  if (!response.ok)
    throw new GitHubError(
      {
        kind:
          response.status === 404
            ? 'not_found'
            : response.status === 401 || response.status === 403
              ? 'authorization'
              : response.status === 409 || response.status === 422
                ? 'conflict'
                : 'forge_error',
        message: `GitHub API request failed with HTTP ${String(response.status)}`,
        status: response.status,
      },
      response.status >= 400 && response.status < 500
    );
  acknowledge?.();
  try {
    return await response.json();
  } catch {
    throw new GitHubError({ kind: 'forge_error', message: 'GitHub API returned invalid JSON' });
  }
}
async function pages<T>(
  fetchImpl: Fetch,
  token: string,
  url: string,
  parse: (raw: unknown) => T[]
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const rows = parse(
      await request(
        fetchImpl,
        token,
        `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${String(page)}`
      )
    );
    out.push(...rows);
    if (rows.length < 100) return out;
  }
}
async function readPull(
  fetchImpl: Fetch,
  token: string,
  ref: { repo: RepoRef; number: number }
): Promise<Pull> {
  const { root, path } = location(ref.repo);
  return pullSchema.parse(
    await request(fetchImpl, token, `${root}/repos/${path}/pulls/${String(ref.number)}`)
  );
}

async function verifyRepository(fetchImpl: Fetch, token: string, repo: RepoRef): Promise<void> {
  const { root, path } = location(repo);
  const observed = repoSchema.parse(await request(fetchImpl, token, `${root}/repos/${path}`));
  if (observed.full_name.toLowerCase() !== repo.path.toLowerCase())
    throw new GitHubError({
      kind: 'invalid_response',
      message: 'GitHub repository read-back did not match the qualified repository',
    });
}

async function readPullHead(
  fetchImpl: Fetch,
  token: string,
  ref: { repo: RepoRef; number: number }
): Promise<string> {
  const { root, path } = location(ref.repo);
  return z
    .object({ head: z.object({ sha: z.string().min(1) }) })
    .parse(await request(fetchImpl, token, `${root}/repos/${path}/pulls/${String(ref.number)}`))
    .head.sha;
}
function record(repo: RepoRef, pull: Pull): ForgePrRecord {
  return forgePrRecordSchema.parse({
    schemaVersion: 1,
    repo,
    number: pull.number,
    url: pull.html_url,
    head: pull.head.ref,
    base: pull.base.ref,
    is_draft: pull.draft,
    state: pull.merged ? 'merged' : pull.state,
    head_repo: pull.head.repo ? { host: repo.host, path: pull.head.repo.full_name } : null,
    head_revision: pull.head.sha,
    base_revision: pull.base.sha,
    maintainer_can_modify: pull.maintainer_can_modify ?? null,
  });
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function base(
  request: ForgeMutationRequest
): ReturnType<typeof mutationEvidence> & { op: ForgeMutationRequest['op'] } {
  return { op: request.op, ...mutationEvidence(request) };
}
function refused(request: ForgeMutationRequest, error: ForgeError): ForgeResponse {
  return fail(request.operationId, error, { ...base(request), outcome: 'refused' });
}
function enforced(request: ForgeMutationRequest): ReturnType<typeof mutationEvidence>['enforced'] {
  return request.op === 'pr.merge' && request.required.head ? { head: request.required.head } : {};
}
function unknown(request: ForgeMutationRequest, error: ForgeError): ForgeResponse {
  return fail(request.operationId, error, {
    ...base(request),
    enforced: {},
    outcome: 'outcome_unknown',
  });
}
function verification(
  request: ForgeMutationRequest,
  message: string,
  leaveBehind: string,
  observed?: ReturnType<typeof record>
): ForgeResponse {
  return fail(
    request.operationId,
    { kind: 'invalid_response', message },
    {
      ...base(request),
      enforced: enforced(request),
      outcome: 'verification_failed',
      leaveBehind,
      ...(observed ? { observed } : {}),
    }
  );
}
function applied(request: ForgeMutationRequest, value: object): ForgeResponse {
  return forgeResponseSchema.parse({
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { ...mutationEvidence(request), outcome: 'applied', ...value },
    },
  });
}

async function mutate(
  requestValue: ForgeMutationRequest,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  let phase: 'not_submitted' | 'submitted' | 'acknowledged' = 'not_submitted';
  if (
    requestValue.op === 'pr.merge' &&
    (requestValue.required.base || requestValue.required.resultTree)
  )
    return refused(requestValue, {
      kind: 'unsupported_condition',
      message: 'GitHub merge atomically supports only the expected head condition',
    });
  try {
    if (requestValue.op === 'pr.create') {
      if (requestValue.headRepo.host !== requestValue.repo.host)
        return refused(requestValue, {
          kind: 'invalid_request',
          message: 'GitHub pull request head and base repositories must use the same host',
        });
      const { root, path } = location(requestValue.repo);
      const headRepository = repositoryPath(requestValue.headRepo.path);
      if (!headRepository)
        return refused(requestValue, {
          kind: 'invalid_request',
          message: `Invalid GitHub head repository path: ${requestValue.headRepo.path}`,
        });
      if (requestValue.headRepo.path !== requestValue.repo.path)
        await verifyRepository(fetchImpl, token, requestValue.headRepo);
      phase = 'submitted';
      const createdRaw = await request(
        fetchImpl,
        token,
        `${root}/repos/${path}/pulls`,
        {
          method: 'POST',
          body: JSON.stringify({
            head:
              requestValue.headRepo.path === requestValue.repo.path
                ? requestValue.head
                : `${headRepository.owner}:${requestValue.head}`,
            ...(requestValue.headRepo.path === requestValue.repo.path
              ? {}
              : { head_repo: headRepository.repo }),
            base: requestValue.base,
            title: requestValue.title,
            body: requestValue.body,
            draft: requestValue.draft,
          }),
        },
        () => {
          phase = 'acknowledged';
        }
      );
      let created: Pull;
      try {
        created = pullSchema.parse(createdRaw);
      } catch {
        return verification(
          requestValue,
          'Created pull request response was malformed',
          'a pull request may exist'
        );
      }
      let observedPull: Pull;
      try {
        observedPull = await readPull(fetchImpl, token, {
          repo: requestValue.repo,
          number: created.number,
        });
      } catch {
        return verification(
          requestValue,
          'Created pull request could not be read back',
          `pull request ${String(created.number)} may exist`
        );
      }
      const pr = record(requestValue.repo, observedPull);
      if (
        observedPull.title !== requestValue.title ||
        (observedPull.body ?? '') !== requestValue.body ||
        pr.head !== requestValue.head ||
        pr.head_revision !== requestValue.headRevision ||
        pr.head_repo?.host !== requestValue.headRepo.host ||
        pr.head_repo?.path !== requestValue.headRepo.path ||
        pr.base !== requestValue.base ||
        pr.is_draft !== requestValue.draft
      )
        return verification(
          requestValue,
          'Created pull request did not match requested fields',
          `pull request ${String(created.number)} may exist`,
          pr
        );
      return applied(requestValue, { changed: true, pr });
    }
    if (
      requestValue.op === 'comment.upsert' &&
      (requestValue.body.split(/\r?\n/, 1)[0] ?? '') !== requestValue.marker
    )
      return refused(requestValue, {
        kind: 'invalid_request',
        message: 'Comment body must begin with the exact canonical marker',
      });
    if (requestValue.op === 'pr.edit-body') {
      const before = await readPull(fetchImpl, token, requestValue.ref);
      const beforeRecord = record(requestValue.ref.repo, before);
      if ((before.body ?? '') === requestValue.body)
        return applied(requestValue, {
          changed: false,
          pr: beforeRecord,
          bodyDigest: digest(requestValue.body),
        });
      const { root, path } = location(requestValue.ref.repo);
      phase = 'submitted';
      await request(
        fetchImpl,
        token,
        `${root}/repos/${path}/pulls/${String(requestValue.ref.number)}`,
        { method: 'PATCH', body: JSON.stringify({ body: requestValue.body }) },
        () => {
          phase = 'acknowledged';
        }
      );
      let after: Pull;
      try {
        after = await readPull(fetchImpl, token, requestValue.ref);
      } catch {
        return verification(
          requestValue,
          'Updated pull request could not be read back',
          'pull request body may have changed'
        );
      }
      const pr = record(requestValue.ref.repo, after);
      return (after.body ?? '') === requestValue.body
        ? applied(requestValue, { changed: true, pr, bodyDigest: digest(requestValue.body) })
        : verification(
            requestValue,
            'Pull request body read-back did not match',
            'pull request body may have changed',
            pr
          );
    }
    if (requestValue.op === 'pr.ready') {
      const before = await readPull(fetchImpl, token, requestValue.ref);
      const beforeRecord = record(requestValue.ref.repo, before);
      if (beforeRecord.state === 'merged')
        return fail(
          requestValue.operationId,
          { kind: 'conflict', message: 'A merged pull request cannot be marked ready' },
          { ...base(requestValue), outcome: 'refused', observed: beforeRecord }
        );
      if (beforeRecord.state === 'open' && !beforeRecord.is_draft)
        return applied(requestValue, { changed: false, pr: beforeRecord });
      if (beforeRecord.state === 'closed')
        return refused(requestValue, {
          kind: 'conflict',
          message: 'A closed pull request cannot be marked ready',
        });
      const { root } = location(requestValue.ref.repo);
      const graphql =
        root === 'https://api.github.com'
          ? `${root}/graphql`
          : `${root.replace(/\/api\/v3$/, '')}/api/graphql`;
      phase = 'submitted';
      const readyRaw = await request(fetchImpl, token, graphql, {
        method: 'POST',
        body: JSON.stringify({
          query:
            'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}',
          variables: { id: before.node_id },
        }),
      });
      const ready = z
        .object({
          data: z.object({
            markPullRequestReadyForReview: z.object({
              pullRequest: z.object({ id: z.string().min(1) }),
            }),
          }),
          errors: z.never().optional(),
        })
        .safeParse(readyRaw);
      if (
        !ready.success ||
        ready.data.data.markPullRequestReadyForReview.pullRequest.id !== before.node_id
      )
        return unknown(requestValue, {
          kind: 'invalid_response',
          message: 'GitHub did not acknowledge the ready mutation',
        });
      phase = 'acknowledged';
      let after: Pull;
      try {
        after = await readPull(fetchImpl, token, requestValue.ref);
      } catch {
        return verification(
          requestValue,
          'Ready pull request could not be read back',
          'pull request ready state may have changed'
        );
      }
      const pr = record(requestValue.ref.repo, after);
      return !pr.is_draft && pr.state === 'open'
        ? applied(requestValue, { changed: true, pr })
        : verification(
            requestValue,
            'Ready read-back did not match',
            'pull request ready state may have changed',
            pr
          );
    }
    if (requestValue.op === 'comment.upsert') {
      const { root, path } = location(requestValue.ref.repo);
      const comments = await pages(
        fetchImpl,
        token,
        `${root}/repos/${path}/issues/${String(requestValue.ref.number)}/comments`,
        raw => z.array(commentSchema).parse(raw)
      );
      const matches = comments.filter(
        comment => (comment.body ?? '').split(/\r?\n/, 1)[0] === requestValue.marker
      );
      if (matches.length > 1)
        return refused(requestValue, {
          kind: 'conflict',
          message: 'Multiple comments contain the canonical marker',
        });
      const previous = matches[0];
      const changed = (previous?.body ?? '') !== requestValue.body;
      let written = previous;
      if (changed) {
        phase = 'submitted';
        const writtenRaw = await request(
          fetchImpl,
          token,
          previous
            ? `${root}/repos/${path}/issues/comments/${String(previous.id)}`
            : `${root}/repos/${path}/issues/${String(requestValue.ref.number)}/comments`,
          {
            method: previous ? 'PATCH' : 'POST',
            body: JSON.stringify({ body: requestValue.body }),
          },
          () => {
            phase = 'acknowledged';
          }
        );
        try {
          written = commentSchema.parse(writtenRaw);
        } catch {
          return verification(
            requestValue,
            'Comment write response was malformed',
            'a comment may have changed'
          );
        }
      }
      if (!written) throw new Error('comment selection invariant failed');
      let observed: z.infer<typeof commentSchema>;
      try {
        observed = commentSchema.parse(
          await request(
            fetchImpl,
            token,
            `${root}/repos/${path}/issues/comments/${String(written.id)}`
          )
        );
      } catch {
        return changed
          ? fail(
              requestValue.operationId,
              { kind: 'invalid_response', message: 'Comment could not be read back' },
              {
                ...base(requestValue),
                outcome: 'verification_failed',
                leaveBehind: `comment ${String(written.id)} may have changed`,
              }
            )
          : refused(requestValue, {
              kind: 'invalid_response',
              message: `Existing comment ${String(written.id)} could not be read back`,
            });
      }
      const comment = {
        ref: requestValue.ref,
        id: String(observed.id),
        url: observed.html_url,
        bodyDigest: digest(observed.body ?? ''),
      };
      const expectedIssueUrl = `${root}/repos/${path}/issues/${String(requestValue.ref.number)}`;
      if (
        String(observed.id) !== String(written.id) ||
        observed.issue_url !== expectedIssueUrl ||
        (observed.body ?? '') !== requestValue.body
      )
        return changed
          ? fail(
              requestValue.operationId,
              { kind: 'invalid_response', message: 'Comment read-back did not match' },
              {
                ...base(requestValue),
                outcome: 'verification_failed',
                leaveBehind: `comment ${String(written.id)} may have changed`,
                comment,
              }
            )
          : refused(requestValue, {
              kind: 'invalid_response',
              message: `Existing comment ${String(observed.id)} read-back did not match its qualified target or body`,
            });
      return applied(requestValue, { changed, comment });
    }
    const { root, path } = location(requestValue.ref.repo);
    phase = 'submitted';
    const mergeRaw = await request(
      fetchImpl,
      token,
      `${root}/repos/${path}/pulls/${String(requestValue.ref.number)}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify({
          merge_method: requestValue.method,
          ...(requestValue.required.head ? { sha: requestValue.required.head } : {}),
        }),
      }
    );
    const mergeParsed = mergeSchema.safeParse(mergeRaw);
    if (!mergeParsed.success)
      return unknown(requestValue, {
        kind: 'invalid_response',
        message: 'GitHub merge response was malformed',
      });
    const merged = mergeParsed.data;
    if (!merged.merged)
      return refused(requestValue, {
        kind: 'conflict',
        message: merged.message ?? 'GitHub refused the merge',
      });
    phase = 'acknowledged';
    let pr;
    try {
      pr = record(requestValue.ref.repo, await readPull(fetchImpl, token, requestValue.ref));
    } catch {
      return verification(
        requestValue,
        'Merged pull request could not be read back',
        `merge reported success${merged.sha ? ` at ${merged.sha}` : ''}`
      );
    }
    if (pr.state !== 'merged')
      return verification(
        requestValue,
        'Merge read-back did not report merged state',
        `merge reported success${merged.sha ? ` at ${merged.sha}` : ''}`,
        pr
      );
    let landed = landedCommitSchema.parse({
      commit: { available: false, reason: 'GitHub merge response omitted the landed commit' },
      tree: { available: false, reason: 'Landed commit is unavailable' },
      parents: { available: false, reason: 'Landed commit is unavailable' },
    });
    if (merged.sha)
      try {
        const commit = commitSchema.parse(
          await request(
            fetchImpl,
            token,
            `${root}/repos/${path}/git/commits/${encodeURIComponent(merged.sha)}`
          )
        );
        if (commit.sha !== merged.sha)
          return verification(
            requestValue,
            'Landed commit read-back did not match the merge response',
            `merge reported success at ${merged.sha}`,
            pr
          );
        landed = landedCommitSchema.parse({
          commit: { available: true, value: commit.sha },
          tree: { available: true, value: commit.tree.sha },
          parents: { available: true, value: commit.parents.map(parent => parent.sha) },
        });
      } catch {
        landed = landedCommitSchema.parse({
          commit: { available: true, value: merged.sha },
          tree: { available: false, reason: 'GitHub commit read-back failed' },
          parents: { available: false, reason: 'GitHub commit read-back failed' },
        });
      }
    return applied(requestValue, {
      changed: true,
      pr,
      method: requestValue.method,
      enforced: requestValue.required.head ? { head: requestValue.required.head } : {},
      landed,
    });
  } catch (cause) {
    const error =
      cause instanceof GitHubError
        ? cause.detail
        : {
            kind: 'forge_error' as const,
            message: cause instanceof Error ? cause.message : String(cause),
          };
    if (phase === 'acknowledged')
      return verification(requestValue, error.message, 'the acknowledged write may remain');
    if (phase === 'submitted' && !(cause instanceof GitHubError && cause.definitiveRefusal))
      return unknown(requestValue, error);
    return refused(requestValue, error);
  }
}

function checkObservation(run: z.infer<typeof checkSchema>): CheckObservation {
  const nativeResult = run.conclusion ?? null;
  const result = checkResult(nativeResult);
  const state = ['queued', 'waiting', 'pending', 'in_progress'].includes(run.status)
    ? 'pending'
    : run.status !== 'completed'
      ? 'unknown'
      : ['success', 'neutral', 'skipped'].includes(result ?? '')
        ? 'green'
        : result === 'action_required'
          ? 'gated'
          : result === 'unknown' || result === null
            ? 'unknown'
            : 'red';
  return {
    unit: { kind: 'check', id: String(run.id), name: run.name },
    nativeState: run.status,
    phase: checkPhase(run.status),
    nativeResult,
    result,
    state,
  };
}
function statusObservation(status: z.infer<typeof statusSchema>): CheckObservation {
  const state =
    status.state === 'pending'
      ? 'pending'
      : status.state === 'success'
        ? 'green'
        : ['failure', 'error'].includes(status.state)
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
  requestValue: ForgeRequest,
  options: GitHubOperationOptions
): Promise<ForgeResponse> {
  try {
    if (requestValue.op === 'resolve') {
      const repo = parseRemote(requestValue.remote);
      return {
        operationId: requestValue.operationId,
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
      return isMutationRequest(requestValue)
        ? refused(requestValue, error)
        : fail(requestValue.operationId, error);
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const token = options.token;
    if (isMutationRequest(requestValue)) return await mutate(requestValue, fetchImpl, token);
    if (requestValue.op === 'workitem.view') {
      const { root, path } = location(requestValue.ref.repo);
      const item = issueSchema.parse(
        await request(
          fetchImpl,
          token,
          `${root}/repos/${path}/issues/${String(requestValue.ref.number)}`
        )
      );
      return {
        operationId: requestValue.operationId,
        ok: true,
        result: {
          op: requestValue.op,
          value: {
            ref: requestValue.ref,
            kind: item.pull_request === undefined ? 'issue' : 'pr',
            url: item.html_url,
            title: item.title,
            body: item.body ?? '',
            state: item.state,
          },
        },
      };
    }
    if (requestValue.op === 'pr.view') {
      if (requestValue.selector.kind === 'number') {
        const pull = await readPull(fetchImpl, token, requestValue.selector.ref);
        return {
          operationId: requestValue.operationId,
          ok: true,
          result: {
            op: requestValue.op,
            value: {
              pr: record(requestValue.selector.ref.repo, pull),
              title: pull.title,
              body: pull.body ?? '',
            },
          },
        };
      }
      if (requestValue.selector.headRepo.host !== requestValue.selector.repo.host)
        return fail(requestValue.operationId, {
          kind: 'invalid_request',
          message: 'GitHub pull request head and base repositories must use the same host',
        });
      const { root, path } = location(requestValue.selector.repo);
      const headRepository = repositoryPath(requestValue.selector.headRepo.path);
      if (!headRepository)
        return fail(requestValue.operationId, {
          kind: 'invalid_request',
          message: `Invalid GitHub head repository path: ${requestValue.selector.headRepo.path}`,
        });
      if (requestValue.selector.headRepo.path !== requestValue.selector.repo.path)
        await verifyRepository(fetchImpl, token, requestValue.selector.headRepo);
      const pulls = z
        .array(pullSchema)
        .parse(
          await request(
            fetchImpl,
            token,
            `${root}/repos/${path}/pulls?state=all&head=${encodeURIComponent(`${headRepository.owner}:${requestValue.selector.head}`)}${requestValue.selector.base ? `&base=${encodeURIComponent(requestValue.selector.base)}` : ''}`
          )
        );
      if (pulls.length > 1)
        return fail(requestValue.operationId, {
          kind: 'conflict',
          message: 'Pull request selector matched multiple pull requests',
        });
      const selected = pulls[0];
      const pull = selected
        ? await readPull(fetchImpl, token, {
            repo: requestValue.selector.repo,
            number: selected.number,
          })
        : undefined;
      return {
        operationId: requestValue.operationId,
        ok: true,
        result: {
          op: requestValue.op,
          value: pull
            ? {
                pr: record(requestValue.selector.repo, pull),
                title: pull.title,
                body: pull.body ?? '',
              }
            : null,
        },
      };
    }
    if (requestValue.op !== 'checks.state') throw new Error('unreachable');
    const revision = await readPullHead(fetchImpl, token, requestValue.ref);
    const { root, path } = location(requestValue.ref.repo);
    const [runs, allStatuses] = await Promise.all([
      pages(
        fetchImpl,
        token,
        `${root}/repos/${path}/commits/${encodeURIComponent(revision)}/check-runs?filter=latest`,
        raw => z.object({ check_runs: z.array(checkSchema) }).parse(raw).check_runs
      ),
      pages(
        fetchImpl,
        token,
        `${root}/repos/${path}/commits/${encodeURIComponent(revision)}/statuses`,
        raw => z.array(statusSchema).parse(raw)
      ),
    ]);
    const contexts = new Set<string>();
    const statuses = allStatuses.filter(status => {
      const key = status.context.toLowerCase();
      if (contexts.has(key)) return false;
      contexts.add(key);
      return true;
    });
    const units = [...runs.map(checkObservation), ...statuses.map(statusObservation)];
    return {
      operationId: requestValue.operationId,
      ok: true,
      result: {
        op: requestValue.op,
        value: {
          ref: requestValue.ref,
          revision,
          units,
          summary: summarizeChecks(units),
          required: null,
        },
      },
    };
  } catch (cause) {
    if (cause instanceof GitHubError) return fail(requestValue.operationId, cause.detail);
    if (cause instanceof z.ZodError)
      return fail(requestValue.operationId, {
        kind: 'forge_error',
        message: `GitHub API response did not match its documented shape: ${cause.issues[0]?.message ?? 'invalid response'}`,
      });
    return fail(requestValue.operationId, {
      kind: 'forge_error',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
