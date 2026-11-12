/** GitHub users projected as forge actors. */

import { z } from 'zod';
import { sourceActorSchema, type SourceActor, type SourceActorAccountType } from '@archon/forge';

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
