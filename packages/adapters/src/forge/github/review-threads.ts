/**
 * Review threads on GitHub: `pr.threads`, `pr.thread.reply`
 * and `pr.thread.resolve`. Threads exist only in GitHub's GraphQL API, so they
 * are read and written there.
 */
import { z } from 'zod';
import {
  contentDigest,
  type ForgeCommentRecord,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  type reviewThreadSchema,
} from '@archon/forge/operations';
import type { PrRef, RepoRef, SourceActor } from '@archon/forge';
import { GitHubError, githubGraphql, repositoryPath, type Fetch } from './api';
import { applied, failure, refused, unverified } from './mutation-outcome';

const graphqlActorSchema = z
  .object({ login: z.string().min(1), databaseId: z.number().int().nullable().optional() })
  .nullable();
const threadCommentNodeSchema = z.object({
  id: z.string().min(1),
  author: graphqlActorSchema,
  body: z.string(),
  url: z.url(),
});
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const commentConnectionSchema = z.object({
  pageInfo: pageInfoSchema,
  nodes: z.array(threadCommentNodeSchema),
});
const threadNodeSchema = z.object({
  id: z.string().min(1),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  comments: commentConnectionSchema,
});
const COMMENT_FIELDS = `pageInfo{hasNextPage endCursor} nodes{id author{login ... on User{databaseId} ... on Bot{databaseId}} body url}`;

function threadActor(host: string, author: z.infer<typeof graphqlActorSchema>): SourceActor | null {
  return author
    ? {
        host,
        id: author.databaseId == null ? author.login : String(author.databaseId),
        login: author.login,
      }
    : null;
}

/** The remaining comments of one thread, after the first page the thread query returned. */
async function remainingThreadComments(
  fetchImpl: Fetch,
  token: string,
  repo: RepoRef,
  thread: string,
  after: string | null
): Promise<z.infer<typeof threadCommentNodeSchema>[]> {
  const comments: z.infer<typeof threadCommentNodeSchema>[] = [];
  let cursor = after;
  for (;;) {
    const data = z
      .object({ node: z.object({ comments: commentConnectionSchema }).nullable() })
      .parse(
        await githubGraphql(
          fetchImpl,
          token,
          repo,
          `query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){${COMMENT_FIELDS}}}}}`,
          { id: thread, after: cursor }
        )
      );
    if (data.node === null)
      throw new GitHubError(
        { kind: 'not_found', message: `Review thread ${thread} was not found` },
        true
      );
    comments.push(...data.node.comments.nodes);
    if (!data.node.comments.pageInfo.hasNextPage) return comments;
    cursor = data.node.comments.pageInfo.endCursor;
  }
}

export async function handleGithubPrThreads(
  request: Extract<ForgeRequest, { op: 'pr.threads' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const name = repositoryPath(request.ref.repo.path);
  if (!name)
    return failure(request.operationId, {
      kind: 'invalid_request',
      message: `Invalid GitHub repository path: ${request.ref.repo.path}`,
    });
  const threads: z.infer<typeof reviewThreadSchema>[] = [];
  let after: string | null = null;
  for (;;) {
    const data = z
      .object({
        repository: z
          .object({
            pullRequest: z
              .object({
                reviewThreads: z.object({
                  pageInfo: pageInfoSchema,
                  nodes: z.array(threadNodeSchema),
                }),
              })
              .nullable(),
          })
          .nullable(),
      })
      .parse(
        await githubGraphql(
          fetchImpl,
          token,
          request.ref.repo,
          `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line comments(first:100){${COMMENT_FIELDS}}}}}}}`,
          { owner: name.owner, name: name.repo, number: request.ref.number, after }
        )
      );
    const connection = data.repository?.pullRequest?.reviewThreads;
    if (!connection)
      return failure(request.operationId, {
        kind: 'not_found',
        message: `Pull request ${String(request.ref.number)} was not found`,
      });
    for (const node of connection.nodes) {
      const comments = node.comments.pageInfo.hasNextPage
        ? [
            ...node.comments.nodes,
            ...(await remainingThreadComments(
              fetchImpl,
              token,
              request.ref.repo,
              node.id,
              node.comments.pageInfo.endCursor
            )),
          ]
        : node.comments.nodes;
      threads.push({
        id: node.id,
        resolved: node.isResolved,
        outdated: node.isOutdated,
        path: node.path,
        line: node.line,
        comments: comments.map(comment => ({
          id: comment.id,
          author: threadActor(request.ref.repo.host, comment.author),
          body: comment.body,
          url: comment.url,
        })),
      });
    }
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }
  return {
    operationId: request.operationId,
    ok: true,
    result: { op: request.op, value: { ref: request.ref, threads } },
  };
}

/**
 * The thread's resolution, when the id names a review thread of the pull request
 * `ref`; null otherwise. An id of another node type answers `node: {}`.
 */
async function readThread(
  fetchImpl: Fetch,
  token: string,
  ref: PrRef,
  thread: string
): Promise<{ resolved: boolean } | null> {
  const data = z
    .object({
      node: z
        .object({
          isResolved: z.boolean().optional(),
          pullRequest: z
            .object({
              number: z.number().int(),
              repository: z.object({ nameWithOwner: z.string() }),
            })
            .optional(),
        })
        .nullable(),
    })
    .parse(
      await githubGraphql(
        fetchImpl,
        token,
        ref.repo,
        `query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved pullRequest{number repository{nameWithOwner}}}}}`,
        { id: thread }
      )
    );
  const node = data.node;
  if (
    node?.isResolved === undefined ||
    !node.pullRequest ||
    node.pullRequest.number !== ref.number ||
    node.pullRequest.repository.nameWithOwner.toLowerCase() !== ref.repo.path.toLowerCase()
  )
    return null;
  return { resolved: node.isResolved };
}

function notThisPullRequest(request: ForgeMutationRequest & { thread: string }): ForgeResponse {
  return refused(request, {
    kind: 'invalid_request',
    message: `${request.thread} is not a review thread on this pull request`,
  });
}

export async function replyOnThread(
  request: Extract<ForgeMutationRequest, { op: 'pr.thread.reply' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  if ((await readThread(fetchImpl, token, request.ref, request.thread)) === null)
    return notThisPullRequest(request);
  submit('submitted');
  const data = z
    .object({
      addPullRequestReviewThreadReply: z
        .object({ comment: z.object({ id: z.string().min(1), body: z.string(), url: z.url() }) })
        .nullable(),
    })
    .safeParse(
      await githubGraphql(
        fetchImpl,
        token,
        request.ref.repo,
        `mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id body url}}}`,
        { thread: request.thread, body: request.body },
        () => {
          submit('acknowledged');
        }
      )
    );
  const comment = data.success ? data.data.addPullRequestReviewThreadReply?.comment : undefined;
  if (!comment)
    return unverified(
      request,
      'GitHub did not return the reply comment',
      'a reply may exist on the thread'
    );
  const record: ForgeCommentRecord = {
    ref: request.ref,
    id: comment.id,
    url: comment.url,
    bodyDigest: contentDigest(comment.body),
  };
  return comment.body === request.body
    ? applied(request, { changed: true, thread: request.thread, comment: record })
    : unverified(request, 'Reply body read-back did not match', 'a reply exists on the thread', {
        comment: record,
      });
}

export async function resolveThread(
  request: Extract<ForgeMutationRequest, { op: 'pr.thread.resolve' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  const before = await readThread(fetchImpl, token, request.ref, request.thread);
  if (before === null) return notThisPullRequest(request);
  if (before.resolved)
    return applied(request, { changed: false, thread: request.thread, resolved: true });
  submit('submitted');
  await githubGraphql(
    fetchImpl,
    token,
    request.ref.repo,
    `mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id}}}`,
    { thread: request.thread },
    () => {
      submit('acknowledged');
    }
  );
  const leaveBehind = 'the thread may be resolved';
  let after: { resolved: boolean } | null;
  try {
    after = await readThread(fetchImpl, token, request.ref, request.thread);
  } catch {
    return unverified(request, 'Resolved thread could not be read back', leaveBehind);
  }
  return after?.resolved
    ? applied(request, { changed: true, thread: request.thread, resolved: true })
    : unverified(request, 'Thread resolution read-back did not match', leaveBehind);
}
