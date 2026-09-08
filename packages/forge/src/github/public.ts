import { z } from 'zod';
import {
  publicRequestSchema,
  publicRequestRepo,
  shaSchema,
  type PublicRequest,
  type PrRecord,
  type RepoRef,
  type ForgeOpError,
  type expectedPrSchema,
  type workItemRecordSchema,
} from '../schemas';
import type { RawOpOutcome } from '../dispatch/plugin-handle';
import type { GitHubPluginOptions } from './plugin';

const repository = z.object({ full_name: z.string(), html_url: z.url() });
const side = z.object({ ref: z.string(), sha: shaSchema, repo: repository });
const pull = z.object({
  number: z.number().int().positive(),
  node_id: z.string(),
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  draft: z.boolean(),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  head: side,
  base: side,
});
const issue = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  pull_request: z.unknown().optional(),
});
const comment = z.object({
  id: z.number().int().positive(),
  html_url: z.url(),
  issue_url: z.url(),
  body: z.string(),
});
class Refusal extends Error {
  constructor(readonly error: ForgeOpError) {
    super(error.kind);
  }
}
function refuse(expected: string, observed: string): never {
  throw new Refusal({ kind: 'verify_failed', expected, observed });
}
function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.host === b.host && a.path.toLowerCase() === b.path.toLowerCase();
}
function repoOf(value: z.infer<typeof repository>): RepoRef {
  const url = new URL(value.html_url);
  if (url.protocol !== 'https:' || url.pathname !== `/${value.full_name}`)
    refuse('qualified repository', 'repository URL mismatch');
  return { host: url.host, path: value.full_name };
}
function identity(pr: PrRecord, expected: z.infer<typeof expectedPrSchema>): void {
  if (
    !sameRepo(pr.head_repo, expected.head_repo) ||
    pr.head !== expected.head ||
    pr.base !== expected.base ||
    pr.head_sha !== expected.head_sha ||
    pr.state !== 'open'
  )
    refuse(
      'open PR with expected head repository, branches and SHA',
      'PR identity or head changed'
    );
}
export async function publicOperation(
  raw: unknown,
  env: NodeJS.ProcessEnv,
  options: GitHubPluginOptions,
  signal?: AbortSignal
): Promise<RawOpOutcome> {
  const parsed = publicRequestSchema.safeParse(raw);
  if (!parsed.success)
    return {
      kind: 'op_error',
      raw: { kind: 'invalid_request', detail: 'Invalid public operation request' },
    };
  const request: PublicRequest = parsed.data;
  const repo = publicRequestRepo(request);
  if (repo.host !== 'github.com' || repo.path.split('/').length !== 2)
    return {
      kind: 'op_error',
      raw: { kind: 'invalid_request', detail: 'Invalid GitHub repository' },
    };
  const token = env.ARCHON_FORGE_TOKEN;
  if (!token) return { kind: 'op_error', raw: { kind: 'no_credential', host: repo.host } };
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  const base = `/repos/${repo.path}`;
  let wrote = false;
  async function api<T>(
    path: string,
    schema: z.ZodType<T>,
    method = 'GET',
    body?: unknown
  ): Promise<T> {
    if (method !== 'GET') wrote = true;
    const response = await (options.fetchImpl ?? fetch)(
      `${options.apiBase ?? 'https://api.github.com'}${path}`,
      {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: bounded,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'archon-forge-github',
        },
      }
    );
    if (!response.ok)
      throw new Refusal(
        response.status === 404 && method === 'GET'
          ? { kind: 'not_found', target: path }
          : {
              kind: 'forge_error',
              status: response.status,
              evidence: `GitHub ${method} failed (HTTP ${String(response.status)})`,
            }
      );
    const result = schema.safeParse(await response.json());
    if (!result.success)
      throw new Refusal({
        kind: 'invalid_response',
        detail: 'GitHub response failed schema validation',
      });
    return result.data;
  }
  function record(value: z.infer<typeof pull>, number = value.number): PrRecord {
    if (
      !sameRepo(repoOf(value.base.repo), repo) ||
      value.number !== number ||
      value.html_url.toLowerCase() !==
        `https://${repo.host}/${repo.path}/pull/${String(number)}`.toLowerCase()
    )
      refuse('requested PR repository, number and URL', 'GitHub returned another target');
    return {
      ref: { repo, number },
      url: value.html_url,
      head_repo: repoOf(value.head.repo),
      head: value.head.ref,
      base: value.base.ref,
      head_sha: value.head.sha,
      is_draft: value.draft,
      state: value.merged_at ? 'merged' : value.state,
      title: value.title,
      body: value.body ?? '',
    };
  }
  async function readPr(number: number): Promise<PrRecord> {
    return record(await api(`${base}/pulls/${String(number)}`, pull), number);
  }
  async function readIssue(number: number): Promise<z.infer<typeof workItemRecordSchema>> {
    const value = await api(`${base}/issues/${String(number)}`, issue);
    if (
      value.number !== number ||
      value.pull_request !== undefined ||
      value.html_url.toLowerCase() !==
        `https://${repo.host}/${repo.path}/issues/${String(number)}`.toLowerCase()
    )
      refuse('requested work item (not a PR)', 'GitHub returned another target kind or identity');
    return {
      ref: { repo, number },
      url: value.html_url,
      title: value.title,
      body: value.body ?? '',
      state: value.state,
    };
  }
  async function pages<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const values = await api(
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${String(page)}`,
        z.array(schema)
      );
      results.push(...values);
      if (values.length < 100) return results;
    }
    throw new Refusal({
      kind: 'invalid_response',
      detail: 'Pagination bound reached; enumeration incomplete',
    });
  }
  try {
    if (request.op === 'pr.view') return { kind: 'ok', value: await readPr(request.ref.number) };
    if (request.op === 'workitem.view')
      return { kind: 'ok', value: await readIssue(request.ref.number) };
    if (request.op === 'pr.create') {
      if (request.head_repo.host !== repo.host || request.head_repo.path.split('/').length !== 2)
        refuse('GitHub head repository', 'unsupported head host or path');
      const branch = await api(
        `/repos/${request.head_repo.path}/branches/${encodeURIComponent(request.head)}`,
        z.object({ name: z.string(), commit: z.object({ sha: shaSchema }) })
      );
      if (branch.name !== request.head || branch.commit.sha !== request.head_sha)
        refuse('pushed branch at expected SHA', 'remote head moved');
      const candidates = await pages(
        `${base}/pulls?state=open&head=${encodeURIComponent(`${request.head_repo.path.split('/')[0]}:${request.head}`)}`,
        pull
      );
      // A branch is one publication identity. A different base is a conflict, not permission to create another PR.
      if (candidates.length > 1) refuse('one PR for head branch', 'ambiguous PRs');
      const value =
        candidates[0] ??
        (await api(`${base}/pulls`, pull, 'POST', {
          title: request.title,
          body: request.body,
          base: request.base,
          head: `${request.head_repo.path.split('/')[0]}:${request.head}`,
          head_repo: request.head_repo.path.split('/')[1],
          draft: request.is_draft,
        }));
      record(value);
      const observed = await readPr(value.number);
      identity(observed, request);
      // Existing branch PRs retain their content and draft state; explicit operations own edits.
      if (
        !candidates.length &&
        (observed.title !== request.title ||
          observed.body !== request.body ||
          observed.is_draft !== request.is_draft)
      )
        refuse('requested title, body and draft state', 'PR content or draft mismatch');
      return { kind: 'ok', value: observed };
    }
    if (request.op === 'comment.upsert') {
      const target = request.target;
      const number = target.ref.number;
      const checkTarget = async (): Promise<void> => {
        if (target.kind === 'pr') identity(await readPr(number), target.expected);
        else await readIssue(number);
      };
      await checkTarget();
      const path = `${base}/issues/${String(number)}/comments`;
      const marked = async (): Promise<z.infer<typeof comment> | undefined> => {
        const all = await pages(path, comment);
        if (
          all.some(
            value =>
              value.issue_url.toLowerCase() !==
              `https://api.github.com${base}/issues/${String(number)}`.toLowerCase()
          )
        )
          refuse('comments on requested target', 'comment target mismatch');
        const matches = all.filter(value => value.body.split(/\r?\n/, 1)[0] === request.marker);
        if (matches.length > 1)
          refuse('one canonical marker comment', 'duplicate markers; operator must reconcile');
        return matches[0];
      };
      const body = `${request.marker}\n${request.body}`;
      const previous = await marked();
      const written =
        previous?.body === body
          ? previous
          : await api(
              previous ? `${base}/issues/comments/${String(previous.id)}` : path,
              comment,
              previous ? 'PATCH' : 'POST',
              { body }
            );
      const observed = await marked();
      await checkTarget();
      if (
        observed?.id !== written.id ||
        observed.body !== body ||
        observed.html_url.toLowerCase() !==
          `https://${repo.host}/${repo.path}/${target.kind === 'pr' ? 'pull' : 'issues'}/${String(number)}#issuecomment-${String(observed.id)}`.toLowerCase()
      )
        refuse(
          'canonical comment at requested target with exact body',
          'comment read-back mismatch'
        );
      return {
        kind: 'ok',
        value: { target, id: observed.id, url: observed.html_url, body: observed.body },
      };
    }
    const path = `${base}/pulls/${String(request.ref.number)}`;
    const before = await api(path, pull);
    identity(record(before, request.ref.number), request.expected);
    if (request.op === 'pr.edit-body') {
      if ((before.body ?? '') !== request.body)
        record(await api(path, pull, 'PATCH', { body: request.body }), request.ref.number);
    } else if (before.draft) {
      await api(
        '/graphql',
        z.object({
          data: z.object({
            markPullRequestReadyForReview: z.object({ pullRequest: z.object({ id: z.string() }) }),
          }),
        }),
        'POST',
        {
          query:
            'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}',
          variables: { id: before.node_id },
        }
      );
    }
    const observed = await readPr(request.ref.number);
    identity(observed, request.expected);
    if (request.op === 'pr.edit-body' ? observed.body !== request.body : observed.is_draft)
      refuse(
        request.op === 'pr.edit-body' ? 'requested body' : 'ready PR',
        request.op === 'pr.edit-body' ? 'body mismatch' : 'PR remains draft'
      );
    return { kind: 'ok', value: observed };
  } catch (error) {
    const failure: ForgeOpError =
      error instanceof Refusal
        ? error.error
        : { kind: 'forge_error', evidence: 'GitHub transport failed or returned invalid JSON' };
    return {
      kind: 'op_error',
      raw: wrote
        ? {
            kind: 'verify_failed',
            expected: 'verified public write',
            observed: failure.kind === 'verify_failed' ? failure.observed : failure.kind,
            leave_behind:
              'Write may have been accepted. Read the qualified target and retry the same request; no automatic cleanup was attempted.',
          }
        : failure,
    };
  }
}
