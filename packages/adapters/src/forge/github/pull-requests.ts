/** GitHub pull request reads and the create, body edit and draft-state mutations. */

import { z } from 'zod';
import {
  contentDigest,
  forgePrRecordSchema,
  reviewItemSchema,
  type ForgeMutationRequest,
  type ForgePrRecord,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import type { PrRef, RepoRef } from '@archon/forge';
import {
  GitHubError,
  githubPages,
  githubRequest,
  location,
  repositoryPath,
  type Fetch,
} from './api';
import { actor, authorField, userSchema } from './actor';
import { applied, failure, refused, unknown, unverified, type Submit } from './mutation-outcome';

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
  merge_commit_sha: z.string().nullable().optional(),
  maintainer_can_modify: z.boolean().nullable().optional(),
  user: userSchema.optional(),
  head: z.object({ ref: z.string().min(1), sha: z.string().min(1), repo: repoSchema.nullable() }),
  base: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
});
type Pull = z.infer<typeof pullSchema>;
const draftStateResponseSchema = z.object({
  data: z.record(z.string(), z.object({ pullRequest: z.object({ id: z.string().min(1) }) })),
});

export async function readPull(fetchImpl: Fetch, token: string, ref: PrRef): Promise<Pull> {
  const { root, path } = location(ref.repo);
  return pullSchema.parse(
    await githubRequest(fetchImpl, token, `${root}/repos/${path}/pulls/${String(ref.number)}`)
  );
}

export function prRecord(repo: RepoRef, pull: Pull): ForgePrRecord {
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

export async function createPullRequest(
  request: Extract<ForgeMutationRequest, { op: 'pr.create' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
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

export async function editPullRequestBody(
  request: Extract<ForgeMutationRequest, { op: 'pr.edit-body' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
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

export async function setDraftState(
  request: Extract<ForgeMutationRequest, { op: 'pr.ready' | 'pr.draft' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const draft = request.op === 'pr.draft';
  const transition = draft ? 'converted to draft' : 'marked ready';
  const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
  const before = await readPull(fetchImpl, token, request.ref);
  const beforeRecord = prRecord(request.ref.repo, before);
  if (beforeRecord.state === 'merged') {
    return refused(
      request,
      { kind: 'conflict', message: `A merged pull request cannot be ${transition}` },
      beforeRecord
    );
  }
  if (beforeRecord.state === 'closed') {
    return refused(
      request,
      { kind: 'conflict', message: `A closed pull request cannot be ${transition}` },
      beforeRecord
    );
  }
  if (beforeRecord.is_draft === draft)
    return applied(request, { changed: false, pr: beforeRecord });

  const { graphql } = location(request.ref.repo);
  submit('submitted');
  // GitHub exposes these draft transitions through GraphQL, not REST.
  const raw = await githubRequest(fetchImpl, token, graphql, {
    method: 'POST',
    body: JSON.stringify({
      query: `mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){pullRequest{id}}}`,
      variables: { id: before.node_id },
    }),
  });
  const acknowledged = draftStateResponseSchema.safeParse(raw);
  // GraphQL answers 200 with an errors document, so an unacknowledged mutation
  // is a submitted write whose effect this call never learned.
  if (
    !acknowledged.success ||
    acknowledged.data.data[mutation]?.pullRequest.id !== before.node_id
  ) {
    return unknown(request, {
      kind: 'invalid_response',
      message: `GitHub did not acknowledge ${request.op}`,
    });
  }
  submit('acknowledged');
  const leaveBehind = 'the pull request draft state may have changed';
  let after: Pull;
  try {
    after = await readPull(fetchImpl, token, request.ref);
  } catch {
    return unverified(request, `${request.op} pull request could not be read back`, leaveBehind);
  }
  const pr = prRecord(request.ref.repo, after);
  return pr.state === 'open' && pr.is_draft === draft
    ? applied(request, { changed: true, pr })
    : unverified(request, `${request.op} read-back did not match`, leaveBehind, { pr });
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
      value: pull
        ? {
            pr: prRecord(repo, pull),
            title: pull.title,
            body: pull.body ?? '',
            ...authorField(repo.host, pull.user),
          }
        : null,
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

export async function handleGithubPrReviews(
  request: Extract<ForgeRequest, { op: 'pr.reviews' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { root, path } = location(request.ref.repo);
  const fields = reviewItemSchema.shape;
  const itemSchema = z.object({
    id: z.union([z.number().int(), fields.id]),
    html_url: fields.url,
    body: fields.body.nullable(),
    user: userSchema,
    commit_id: fields.commit.optional(),
    state: fields.state.optional(),
    submitted_at: fields.createdAt.optional(),
    created_at: fields.createdAt.optional(),
    in_reply_to_id: z.number().nullable().optional(),
  });
  const base = `${root}/repos/${path}/pulls/${String(request.ref.number)}`;
  const [reviews, comments] = await Promise.all([
    githubPages(fetchImpl, token, `${base}/reviews`, value => z.array(itemSchema).parse(value)),
    githubPages(fetchImpl, token, `${base}/comments`, value => z.array(itemSchema).parse(value)),
  ]);
  const project = (
    item: z.infer<typeof itemSchema>,
    kind: 'review' | 'review_comment'
  ): z.infer<typeof reviewItemSchema> => ({
    kind,
    id: String(item.id),
    author: actor(request.ref.repo.host, item.user),
    commit: item.commit_id ?? null,
    state: kind === 'review' ? (item.state ?? null) : null,
    createdAt: (kind === 'review' ? item.submitted_at : item.created_at) ?? null,
    url: item.html_url,
    body: item.body ?? '',
  });
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: {
        ref: request.ref,
        items: [
          ...reviews.filter(item => item.state !== 'PENDING').map(item => project(item, 'review')),
          ...comments
            .filter(item => item.in_reply_to_id == null)
            .map(item => project(item, 'review_comment')),
        ],
      },
    },
  };
}
