/**
 * GitHub's work-item and pull-request lifecycle operations.
 *
 * Every mutation here submits at most one write and then reads the result back
 * from GitHub before claiming it. The outcome a caller receives is decided by how
 * far the write got: nothing submitted is a refusal, a submitted request whose
 * answer was lost is unknown, and an acknowledged write whose read-back does not
 * agree is a verification failure carrying what may remain on the forge.
 */

import { z } from 'zod';
import {
  contentDigest,
  forgePrRecordSchema,
  mutationTarget,
  type ForgeCommentRecord,
  type ForgeError,
  type ForgeMutationFailure,
  type ForgeMutationRequest,
  type ForgePrRecord,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import type { PrRef, RepoRef } from '@archon/forge';
import {
  GitHubError,
  githubErrorDetail,
  githubPages,
  githubRequest,
  graphqlEndpoint,
  location,
  repositoryPath,
  type Fetch,
} from './api';

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
type Comment = z.infer<typeof commentSchema>;

function failure(
  operationId: string,
  error: ForgeError,
  mutation?: ForgeMutationFailure
): ForgeResponse {
  return mutation ? { operationId, ok: false, error, mutation } : { operationId, ok: false, error };
}

async function readPull(fetchImpl: Fetch, token: string, ref: PrRef): Promise<Pull> {
  const { root, path } = location(ref.repo);
  return pullSchema.parse(
    await githubRequest(fetchImpl, token, `${root}/repos/${path}/pulls/${String(ref.number)}`)
  );
}

function prRecord(repo: RepoRef, pull: Pull): ForgePrRecord {
  return forgePrRecordSchema.parse({
    schemaVersion: 1,
    repo,
    number: pull.number,
    url: pull.html_url,
    head: pull.head.ref,
    base: pull.base.ref,
    is_draft: pull.draft,
    state: pull.merged ? 'merged' : pull.state,
    // A head branch lives in the same GitHub instance, so it inherits the host
    // and differs only in repository path.
    head_repo: pull.head.repo ? { host: repo.host, path: pull.head.repo.full_name } : null,
    head_revision: pull.head.sha,
    base_revision: pull.base.sha,
    maintainer_can_modify: pull.maintainer_can_modify ?? null,
  });
}

/**
 * Repository identity, compared the way GitHub registers it.
 *
 * GitHub echoes `owner/name` in its canonically-registered case whatever case a
 * request carried, so an exact comparison would read a pull request that was
 * created exactly as asked as one whose head repository disagrees.
 */
function sameRepo(left: RepoRef, right: RepoRef): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}

/** Prove a fork head repository exists and is the one that was named. */
async function verifyRepository(fetchImpl: Fetch, token: string, repo: RepoRef): Promise<void> {
  const { root, path } = location(repo);
  const observed = repoSchema.parse(await githubRequest(fetchImpl, token, `${root}/repos/${path}`));
  if (observed.full_name.toLowerCase() !== repo.path.toLowerCase()) {
    throw new GitHubError(
      {
        kind: 'invalid_response',
        message: 'GitHub repository read-back did not match the qualified repository',
      },
      true
    );
  }
}

function evidenceBase(request: ForgeMutationRequest): {
  op: typeof request.op;
  target: ReturnType<typeof mutationTarget>;
} {
  return { op: request.op, target: mutationTarget(request) };
}
function refused(
  request: ForgeMutationRequest,
  error: ForgeError,
  observed?: ForgePrRecord
): ForgeResponse {
  return failure(request.operationId, error, {
    ...evidenceBase(request),
    outcome: 'refused',
    ...(observed ? { observed } : {}),
  });
}
function unknown(request: ForgeMutationRequest, error: ForgeError): ForgeResponse {
  return failure(request.operationId, error, {
    ...evidenceBase(request),
    outcome: 'outcome_unknown',
  });
}
function unverified(
  request: ForgeMutationRequest,
  message: string,
  leaveBehind: string,
  observed?: { pr?: ForgePrRecord; comment?: ForgeCommentRecord }
): ForgeResponse {
  return failure(
    request.operationId,
    { kind: 'invalid_response', message },
    {
      ...evidenceBase(request),
      outcome: 'verification_failed',
      leaveBehind,
      ...(observed?.pr ? { observed: observed.pr } : {}),
      ...(observed?.comment ? { comment: observed.comment } : {}),
    }
  );
}
function applied(request: ForgeMutationRequest, value: object): ForgeResponse {
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { target: mutationTarget(request), outcome: 'applied', ...value },
    },
  } as ForgeResponse;
}

async function createPullRequest(
  request: Extract<ForgeMutationRequest, { op: 'pr.create' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  if (request.headRepo.host !== request.repo.host) {
    return refused(request, {
      kind: 'invalid_request',
      message: 'GitHub pull request head and base repositories must use the same host',
    });
  }
  const headRepository = repositoryPath(request.headRepo.path);
  if (!headRepository) {
    return refused(request, {
      kind: 'invalid_request',
      message: `Invalid GitHub head repository path: ${request.headRepo.path}`,
    });
  }
  const sameRepository = request.headRepo.path === request.repo.path;
  if (!sameRepository) await verifyRepository(fetchImpl, token, request.headRepo);
  const { root, path } = location(request.repo);
  submit('submitted');
  const raw = await githubRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        head: sameRepository ? request.head : `${headRepository.owner}:${request.head}`,
        ...(sameRepository ? {} : { head_repo: headRepository.repo }),
        base: request.base,
        title: request.title,
        body: request.body,
        draft: request.draft,
      }),
    },
    () => {
      submit('acknowledged');
    }
  );
  let created: Pull;
  try {
    created = pullSchema.parse(raw);
  } catch {
    return unverified(
      request,
      'Created pull request response was malformed',
      'a pull request may exist'
    );
  }
  const leaveBehind = `pull request ${String(created.number)} may exist`;
  let observed: Pull;
  try {
    observed = await readPull(fetchImpl, token, { repo: request.repo, number: created.number });
  } catch {
    return unverified(request, 'Created pull request could not be read back', leaveBehind);
  }
  const pr = prRecord(request.repo, observed);
  if (
    observed.title !== request.title ||
    (observed.body ?? '') !== request.body ||
    pr.head !== request.head ||
    pr.head_revision !== request.headRevision ||
    pr.head_repo === null ||
    !sameRepo(pr.head_repo, request.headRepo) ||
    pr.base !== request.base ||
    pr.is_draft !== request.draft ||
    pr.state !== 'open'
  ) {
    return unverified(request, 'Created pull request did not match requested fields', leaveBehind, {
      pr,
    });
  }
  return applied(request, { changed: true, pr });
}

async function editPullRequestBody(
  request: Extract<ForgeMutationRequest, { op: 'pr.edit-body' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  const before = await readPull(fetchImpl, token, request.ref);
  if ((before.body ?? '') === request.body) {
    return applied(request, {
      changed: false,
      pr: prRecord(request.ref.repo, before),
      bodyDigest: contentDigest(request.body),
    });
  }
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  await githubRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/pulls/${String(request.ref.number)}`,
    { method: 'PATCH', body: JSON.stringify({ body: request.body }) },
    () => {
      submit('acknowledged');
    }
  );
  const leaveBehind = 'the pull request body may have changed';
  let after: Pull;
  try {
    after = await readPull(fetchImpl, token, request.ref);
  } catch {
    return unverified(request, 'Updated pull request could not be read back', leaveBehind);
  }
  const pr = prRecord(request.ref.repo, after);
  return (after.body ?? '') === request.body
    ? applied(request, { changed: true, pr, bodyDigest: contentDigest(request.body) })
    : unverified(request, 'Pull request body read-back did not match', leaveBehind, { pr });
}

const readyMutationSchema = z.object({
  data: z.object({
    markPullRequestReadyForReview: z.object({ pullRequest: z.object({ id: z.string().min(1) }) }),
  }),
});

async function markReady(
  request: Extract<ForgeMutationRequest, { op: 'pr.ready' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  const before = await readPull(fetchImpl, token, request.ref);
  const beforeRecord = prRecord(request.ref.repo, before);
  if (beforeRecord.state === 'merged') {
    return refused(
      request,
      { kind: 'conflict', message: 'A merged pull request cannot be marked ready' },
      beforeRecord
    );
  }
  if (beforeRecord.state === 'closed') {
    return refused(
      request,
      { kind: 'conflict', message: 'A closed pull request cannot be marked ready' },
      beforeRecord
    );
  }
  if (!beforeRecord.is_draft) return applied(request, { changed: false, pr: beforeRecord });

  const { root } = location(request.ref.repo);
  submit('submitted');
  // REST cannot clear draft state; this is the only supported transition.
  const raw = await githubRequest(fetchImpl, token, graphqlEndpoint(root), {
    method: 'POST',
    body: JSON.stringify({
      query:
        'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}',
      variables: { id: before.node_id },
    }),
  });
  const acknowledged = readyMutationSchema.safeParse(raw);
  // GraphQL answers 200 with an errors document, so an unacknowledged mutation
  // is a submitted write whose effect this call never learned.
  if (
    !acknowledged.success ||
    acknowledged.data.data.markPullRequestReadyForReview.pullRequest.id !== before.node_id
  ) {
    return unknown(request, {
      kind: 'invalid_response',
      message: 'GitHub did not acknowledge the ready mutation',
    });
  }
  submit('acknowledged');
  const leaveBehind = 'the pull request draft state may have changed';
  let after: Pull;
  try {
    after = await readPull(fetchImpl, token, request.ref);
  } catch {
    return unverified(request, 'Ready pull request could not be read back', leaveBehind);
  }
  const pr = prRecord(request.ref.repo, after);
  return pr.state === 'open' && !pr.is_draft
    ? applied(request, { changed: true, pr })
    : unverified(request, 'Ready read-back did not match', leaveBehind, { pr });
}

function commentRecord(ref: PrRef, comment: Comment): ForgeCommentRecord {
  return {
    ref,
    id: String(comment.id),
    url: comment.html_url,
    bodyDigest: contentDigest(comment.body ?? ''),
  };
}

async function upsertComment(
  request: Extract<ForgeMutationRequest, { op: 'comment.upsert' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  // The marker is how the canonical comment is found again next round, so a body
  // that does not carry it would silently create a second report.
  if ((request.body.split(/\r?\n/, 1)[0] ?? '') !== request.marker) {
    return refused(request, {
      kind: 'invalid_request',
      message: 'Comment body must begin with the exact canonical marker',
    });
  }
  const { root, path } = location(request.ref.repo);
  const issue = `${root}/repos/${path}/issues/${String(request.ref.number)}`;
  const comments = await githubPages(fetchImpl, token, `${issue}/comments`, raw =>
    z.array(commentSchema).parse(raw)
  );
  const marked = comments.filter(
    comment => (comment.body ?? '').split(/\r?\n/, 1)[0] === request.marker
  );
  if (marked.length > 1) {
    return refused(request, {
      kind: 'conflict',
      message: 'Multiple comments on this pull request carry the canonical marker',
    });
  }
  const previous = marked[0];
  if (previous && (previous.body ?? '') === request.body) {
    // The listing is the read-back: the canonical comment already carries this body.
    return applied(request, { changed: false, comment: commentRecord(request.ref, previous) });
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
      'a comment may have changed'
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
    return unverified(request, 'Comment could not be read back', leaveBehind);
  }
  const comment = commentRecord(request.ref, observed);
  if (
    String(observed.id) !== String(written.id) ||
    // GitHub echoes owner/name in its registered case (see sameRepo).
    observed.issue_url.toLowerCase() !== issue.toLowerCase() ||
    (observed.body ?? '') !== request.body
  ) {
    return unverified(request, 'Comment read-back did not match', leaveBehind, { comment });
  }
  return applied(request, { changed: true, comment });
}

export async function handleGithubMutation(
  request: ForgeMutationRequest,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const progress: { phase: 'not_submitted' | 'submitted' | 'acknowledged' } = {
    phase: 'not_submitted',
  };
  const submit = (next: 'submitted' | 'acknowledged'): void => {
    progress.phase = next;
  };
  try {
    switch (request.op) {
      case 'pr.create':
        return await createPullRequest(request, fetchImpl, token, submit);
      case 'pr.edit-body':
        return await editPullRequestBody(request, fetchImpl, token, submit);
      case 'pr.ready':
        return await markReady(request, fetchImpl, token, submit);
      case 'comment.upsert':
        return await upsertComment(request, fetchImpl, token, submit);
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

export async function handleGithubWorkItemView(
  request: Extract<ForgeRequest, { op: 'workitem.view' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { root, path } = location(request.ref.repo);
  const item = issueSchema.parse(
    await githubRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/issues/${String(request.ref.number)}`
    )
  );
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'workitem.view',
      value: {
        ref: request.ref,
        // GitHub's issues endpoint serves pull requests too, and only this field
        // distinguishes them.
        kind: item.pull_request === undefined ? 'issue' : 'pr',
        url: item.html_url,
        title: item.title,
        body: item.body ?? '',
        state: item.state,
      },
    },
  };
}

export async function handleGithubPrView(
  request: Extract<ForgeRequest, { op: 'pr.view' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const view = (pull: Pull | undefined, repo: RepoRef): ForgeResponse => ({
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'pr.view',
      value: pull ? { pr: prRecord(repo, pull), title: pull.title, body: pull.body ?? '' } : null,
    },
  });
  if (request.selector.kind === 'number') {
    return view(await readPull(fetchImpl, token, request.selector.ref), request.selector.ref.repo);
  }
  const selector = request.selector;
  if (selector.headRepo.host !== selector.repo.host) {
    return failure(request.operationId, {
      kind: 'invalid_request',
      message: 'GitHub pull request head and base repositories must use the same host',
    });
  }
  const headRepository = repositoryPath(selector.headRepo.path);
  if (!headRepository) {
    return failure(request.operationId, {
      kind: 'invalid_request',
      message: `Invalid GitHub head repository path: ${selector.headRepo.path}`,
    });
  }
  if (selector.headRepo.path !== selector.repo.path)
    await verifyRepository(fetchImpl, token, selector.headRepo);
  const { root, path } = location(selector.repo);
  // GitHub's default state is open, which is what a head selector means: a branch
  // closed long ago must not answer for the pull request this head has now.
  const query = `head=${encodeURIComponent(`${headRepository.owner}:${selector.head}`)}${
    selector.base === undefined ? '' : `&base=${encodeURIComponent(selector.base)}`
  }`;
  const matches = z
    .array(pullSchema)
    .parse(await githubRequest(fetchImpl, token, `${root}/repos/${path}/pulls?${query}`));
  if (matches.length > 1) {
    return failure(request.operationId, {
      kind: 'conflict',
      message: 'Pull request head selector matched more than one pull request',
    });
  }
  const selected = matches[0];
  return view(
    selected
      ? await readPull(fetchImpl, token, { repo: selector.repo, number: selected.number })
      : undefined,
    selector.repo
  );
}
