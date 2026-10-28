/**
 * `pr.merge-state` on GitHub: how far a pull request's head is behind the default
 * branch, and whether it merges. GraphQL's `compare(headRef:)` takes a commit from
 * any fork of the repository, which REST compare by SHA does not promise.
 */
import { z } from 'zod';
import type { ForgeRequest, ForgeResponse } from '@archon/forge/operations';
import { GitHubError, githubGraphql, githubRepository, type Fetch } from './api';

const pullSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          headRefOid: z.string().min(1),
          mergeable: z.string(),
          mergeCommit: z.object({ oid: z.string().min(1) }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
});
const compareSchema = z.object({
  repository: z
    .object({
      defaultBranchRef: z
        .object({
          name: z.string().min(1),
          target: z.object({ oid: z.string().min(1) }),
          compare: z.object({ behindBy: z.number().int().nonnegative() }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

function notFound(message: string): GitHubError {
  return new GitHubError({ kind: 'not_found', message }, true);
}

export async function handleGithubPrMergeState(
  request: Extract<ForgeRequest, { op: 'pr.merge-state' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { repo, number } = request.ref;
  const { owner, repo: name } = githubRepository(repo);
  const pull = pullSchema.parse(
    await githubGraphql(
      fetchImpl,
      token,
      repo,
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid mergeable mergeCommit{oid}}}}',
      { owner, name, number }
    )
  ).repository?.pullRequest;
  if (!pull) throw notFound(`${repo.path} has no pull request ${String(number)}`);
  const branch = compareSchema.parse(
    await githubGraphql(
      fetchImpl,
      token,
      repo,
      'query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{oid} compare(headRef:$head){behindBy}}}}',
      { owner, name, head: pull.headRefOid }
    )
  ).repository?.defaultBranchRef;
  if (!branch) throw notFound(`${repo.path} reports no default branch`);
  if (!branch.compare)
    throw notFound(`${repo.path} cannot compare ${pull.headRefOid} with ${branch.name}`);
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'pr.merge-state',
      value: {
        ref: request.ref,
        head_revision: pull.headRefOid,
        default_branch: branch.name,
        default_revision: branch.target.oid,
        behind: branch.compare.behindBy,
        // GitHub computes mergeability lazily, so a first read may be UNKNOWN.
        mergeable:
          pull.mergeable === 'MERGEABLE'
            ? 'clean'
            : pull.mergeable === 'CONFLICTING'
              ? 'conflict'
              : 'unknown',
        merge_commit: pull.mergeCommit?.oid ?? null,
      },
    },
  };
}
