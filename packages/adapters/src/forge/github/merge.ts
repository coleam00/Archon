/** Merging a GitHub pull request at its approved head, with the landed commit as evidence. */

import { z } from 'zod';
import type { ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { githubRequest, location, type Fetch } from './api';
import { applied, refused, unverified, type Submit } from './mutation-outcome';
import { prRecord, readPull } from './pull-requests';

export async function mergePullRequest(
  request: Extract<ForgeMutationRequest, { op: 'pr.merge' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  if (!request.conditions.head)
    return refused(request, {
      kind: 'invalid_request',
      message: 'A merge requires the approved head condition',
    });
  if (Object.keys(request.conditions).some(key => key !== 'head'))
    return refused(request, {
      kind: 'unsupported_op',
      message: 'GitHub enforces only the head merge condition',
    });
  const before = await readPull(fetchImpl, token, request.ref);
  if (
    before.number !== request.ref.number ||
    before.head.sha !== request.conditions.head ||
    before.state !== 'open' ||
    before.merged ||
    before.draft
  )
    return refused(
      request,
      { kind: 'conflict', message: 'Pull request is not open and ready at the requested head' },
      prRecord(request.ref.repo, before)
    );
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  const result = z.object({ merged: z.boolean(), sha: z.string().nullable().optional() }).parse(
    await githubRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/pulls/${String(request.ref.number)}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify({ sha: request.conditions.head, merge_method: request.method }),
      },
      () => {
        submit('acknowledged');
      }
    )
  );
  if (!result.merged)
    return refused(request, { kind: 'conflict', message: 'GitHub declined the merge' });
  const observed = await readPull(fetchImpl, token, request.ref);
  const pr = prRecord(request.ref.repo, observed);
  const commit = observed.merge_commit_sha ?? null;
  if (
    pr.number !== request.ref.number ||
    pr.state !== 'merged' ||
    pr.head_revision !== request.conditions.head ||
    !commit ||
    result.sha !== commit
  )
    return unverified(
      request,
      'Merged pull request read-back did not match',
      'the pull request may be merged',
      { pr, landed: { commit, tree: null, parents: null } }
    );
  let tree: string | null = null;
  let parents: string[] | null = null;
  let raw: unknown;
  try {
    raw = await githubRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/git/commits/${encodeURIComponent(commit)}`
    );
  } catch {
    return applied(request, {
      changed: true,
      pr,
      method: request.method,
      conditions: request.conditions,
      enforcedConditions: ['head'],
      landed: { commit, tree, parents },
    });
  }
  const object = z
    .object({
      sha: z.string(),
      tree: z.object({ sha: z.string().min(1) }).optional(),
      parents: z.array(z.object({ sha: z.string().min(1) })).optional(),
    })
    .safeParse(raw);
  if (!object.success || object.data.sha !== commit)
    return unverified(
      request,
      'Landed commit identity did not match',
      'the pull request is merged',
      { pr, landed: { commit, tree: null, parents: null } }
    );
  tree = object.data.tree?.sha ?? null;
  parents = object.data.parents?.map(parent => parent.sha) ?? null;
  return applied(request, {
    changed: true,
    pr,
    method: request.method,
    conditions: request.conditions,
    enforcedConditions: ['head'],
    landed: { commit, tree, parents },
  });
}
