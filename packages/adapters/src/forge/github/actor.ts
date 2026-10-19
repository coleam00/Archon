/** GitHub users projected as forge actors. */

import { z } from 'zod';
import { sourceActorSchema, type SourceActor } from '@archon/forge';

const actorFields = sourceActorSchema.shape;
export const userSchema = z
  .object({
    id: z.union([z.number().int(), actorFields.id]),
    login: actorFields.login.optional(),
  })
  .nullable();
type User = z.infer<typeof userSchema>;

export function actor(host: string, user: User): SourceActor | null {
  return user ? { host, id: String(user.id), login: user.login ?? null } : null;
}
/** A response without `user` reports no author rather than claiming the forge has none. */
export function authorField(host: string, user: User | undefined): { author?: SourceActor | null } {
  return user === undefined ? {} : { author: actor(host, user) };
}
