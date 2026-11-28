/** GitHub users projected as forge actors. */

import { z } from 'zod';
import { sourceActorSchema, type SourceActor, type SourceActorAccountType } from '@archon/forge';
import type { ForgeRequest, ForgeResponse } from '@archon/forge/operations';
import { GitHubError, githubRequest, location, type Fetch } from './api';

const actorFields = sourceActorSchema.shape;
export const userSchema = z
  .object({
    id: z.union([z.number().int(), actorFields.id]),
    login: actorFields.login.optional(),
    // REST `type`; GitHub also reports kinds the forge contract does not name.
    type: z.string().optional(),
  })
  .nullable();
type User = z.infer<typeof userSchema>;

/** Maps REST `user.type` or GraphQL `__typename`; any other account kind is null. */
export function accountType(name: string | null | undefined): SourceActorAccountType | null {
  switch (name) {
    case 'User':
      return 'user';
    case 'Bot':
      return 'bot';
    case 'Organization':
      return 'organization';
    default:
      return null;
  }
}

export function actor(host: string, user: User): SourceActor | null {
  return user
    ? { host, id: String(user.id), login: user.login ?? null, type: accountType(user.type) }
    : null;
}
/** A response without `user` reports no author rather than claiming the forge has none. */
export function authorField(host: string, user: User | undefined): { author?: SourceActor | null } {
  return user === undefined ? {} : { author: actor(host, user) };
}

export const graphqlActorSchema = z
  .object({
    __typename: z.string().optional(),
    login: z.string().min(1),
    id: z.string().min(1),
    databaseId: z.number().int().nullable().optional(),
  })
  .nullable();
/** The selection `graphqlActorSchema` reads from a GraphQL `Actor`. */
export const GRAPHQL_ACTOR_FIELDS =
  '__typename login ... on Node{id} ... on User{databaseId} ... on Bot{databaseId} ... on Organization{databaseId} ... on Mannequin{databaseId}';

/**
 * `id` is the account's database id, the number REST and webhooks report. An author kind
 * GitHub gives no database id (an enterprise user account) keeps its GraphQL node id, which
 * survives a rename as the login does not.
 */
export function graphqlActor(
  host: string,
  author: z.infer<typeof graphqlActorSchema>
): SourceActor | null {
  return author
    ? {
        host,
        id: author.databaseId == null ? author.id : String(author.databaseId),
        login: author.login,
        type: accountType(author.__typename),
      }
    : null;
}

/**
 * The account the token acts as. A GitHub App installation token has no user, and
 * GitHub answers 403, which reaches the caller as `authorization`.
 */
export async function handleGithubActorSelf(
  request: Extract<ForgeRequest, { op: 'actor.self' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { root } = location(request.repo);
  const self = actor(
    request.repo.host,
    userSchema.parse(await githubRequest(fetchImpl, token, `${root}/user`))
  );
  if (!self?.login)
    throw new GitHubError({
      kind: 'invalid_response',
      message: 'GitHub reported no login for the authenticated user',
    });
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'actor.self',
      value: { repo: request.repo, actor: { ...self, login: self.login } },
    },
  };
}
