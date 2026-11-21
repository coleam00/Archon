import { z } from 'zod';
import { contentDigest, type ForgeRequest, type ForgeResponse } from '@archon/forge/operations';
import { trustedActor, trustedTextDigest, type TrustedText } from '@archon/forge';
import { actor, userSchema } from './actor';
import {
  GitHubError,
  githubGraphql,
  githubRepository,
  githubRequest,
  location,
  type Fetch,
} from './api';
import { defaultBranchHead } from './commit-checks';
import { handleGithubRepoFile } from './files';
import { readIssue, subjectRecord } from './workitems';

type TrustRequest = Extract<ForgeRequest, { op: 'workitem.trust' | 'workitem.accept' }>;

const editProvenanceSchema = z.object({
  repository: z.object({
    issue: z
      .object({
        title: z.string(),
        body: z.string(),
        editor: z.object({ login: z.string() }).nullable(),
        lastEditedAt: z.string().nullable(),
        timelineItems: z.object({
          nodes: z.array(
            z
              .object({
                actor: z.object({ login: z.string() }).nullable(),
                createdAt: z.string(),
                currentTitle: z.string(),
              })
              .nullable()
          ),
        }),
      })
      .nullable()
      .optional(),
    pullRequest: z
      .object({
        title: z.string(),
        body: z.string(),
        editor: z.object({ login: z.string() }).nullable(),
        lastEditedAt: z.string().nullable(),
        timelineItems: z.object({
          nodes: z.array(
            z
              .object({
                actor: z.object({ login: z.string() }).nullable(),
                createdAt: z.string(),
                currentTitle: z.string(),
              })
              .nullable()
          ),
        }),
      })
      .nullable()
      .optional(),
  }),
});

async function readEditProvenance(request: TrustRequest, fetch: Fetch, token: string) {
  const { owner, repo } = githubRepository(request.subject.ref.repo);
  const field = request.subject.kind === 'issue' ? 'issue' : 'pullRequest';
  const response = editProvenanceSchema.parse(
    await githubGraphql(
      fetch,
      token,
      request.subject.ref.repo,
      `query trustedTextProvenance($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){${field}(number:$number){title body editor{login} lastEditedAt timelineItems(itemTypes:[RENAMED_TITLE_EVENT],last:1){nodes{... on RenamedTitleEvent{actor{login} createdAt currentTitle}}}}}}`,
      { owner, name: repo, number: request.subject.ref.number }
    )
  );
  const value = response.repository[field];
  if (!value) throw new GitHubError({ kind: 'not_found', message: 'Work item was not found' });
  const renamed = value.timelineItems.nodes.at(-1);
  const sourceActor = (login: string) => ({
    host: request.subject.ref.repo.host,
    id: login,
    login,
  });
  return {
    title: value.title,
    body: value.body,
    editor: value.editor ? sourceActor(value.editor.login) : null,
    lastEditedAt: value.lastEditedAt,
    ...(renamed === undefined
      ? { titleEditor: null, titleEditedAt: null }
      : renamed?.currentTitle === value.title
        ? {
            titleEditor: renamed.actor ? sourceActor(renamed.actor.login) : null,
            titleEditedAt: renamed.createdAt,
          }
        : {}),
  };
}

async function readTrust(request: TrustRequest, fetch: Fetch, token: string): Promise<TrustedText> {
  const repo = request.subject.ref.repo;
  const head = await defaultBranchHead(fetch, token, repo);
  if (!head)
    throw new GitHubError({
      kind: 'authorization',
      message: 'Trusted-text policy has no readable default-branch head',
    });
  const response = await handleGithubRepoFile(
    {
      operationId: request.operationId,
      op: 'repo.file',
      repo,
      path: request.maintainersPath,
      revision: head.revision,
    },
    fetch,
    token
  );
  if (!response.ok || response.result.op !== 'repo.file')
    throw new GitHubError({
      kind: 'authorization',
      message: 'Trusted-text maintainer policy is unreadable',
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.result.value.text);
  } catch {
    throw new GitHubError({
      kind: 'authorization',
      message: 'Trusted-text maintainer policy is invalid',
    });
  }
  const maintainers = z
    .array(z.string().trim().min(1))
    .parse(parsed)
    .map(login => login.toLowerCase());
  const item = await readIssue(fetch, token, request.subject.ref);
  const provenance = await readEditProvenance(request, fetch, token);
  const { title, body, ...editProvenance } = provenance;
  return {
    subject: subjectRecord(request.subject, item),
    title,
    body,
    contentDigest: trustedTextDigest(title, body),
    ...('user' in item ? { author: actor(repo.host, item.user ?? null) } : {}),
    ...editProvenance,
    policy: {
      maintainersPath: request.maintainersPath,
      head: head.revision,
      digest: contentDigest(response.result.value.text),
      maintainers,
    },
  };
}

export async function handleGithubWorkItemTrust(
  request: TrustRequest,
  fetch: Fetch,
  token: string
): Promise<ForgeResponse> {
  const value = await readTrust(request, fetch, token);
  if (request.op === 'workitem.trust')
    return { operationId: request.operationId, ok: true, result: { op: request.op, value } };

  if (trustedTextDigest(value.title, value.body) !== request.expectedContentDigest)
    throw new GitHubError({
      kind: 'conflict',
      message: 'Trusted text changed before acceptance',
    });
  const rawActor = userSchema.parse(
    await githubRequest(fetch, token, `${location(request.subject.ref.repo).root}/user`)
  );
  const acceptedBy = actor(request.subject.ref.repo.host, rawActor);
  if (!acceptedBy || !trustedActor(acceptedBy, value.policy))
    throw new GitHubError({
      kind: 'authorization',
      message: 'The authenticated actor is not a current maintainer',
    });
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { ...value, acceptedBy, scope: request.scope },
    },
  };
}
