import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

export const repoRefSchema = z
  .object({
    host: nonEmpty,
    path: nonEmpty,
    // Preserve the authorizing claim when HTTPS's explicit default port differs from it.
    hostClaim: z.literal(true).optional(),
  })
  .refine(repo => {
    if (!repo.hostClaim) return true;
    const host = repo.host.toLowerCase();
    const claim = host.slice(0, -4);
    try {
      const url = new URL(`https://${claim}`);
      return url.host === claim && url.hostname === claim && host === `${claim}:443`;
    } catch {
      return false;
    }
  }, 'A host claim marker requires a bare host with an explicit :443 port');
export type RepoRef = z.infer<typeof repoRefSchema>;

export const prRefSchema = z.object({
  repo: repoRefSchema,
  number: z.number().int().positive(),
});
export type PrRef = z.infer<typeof prRefSchema>;

export const workItemRefSchema = z.object({
  repo: repoRefSchema,
  number: z.number().int().positive(),
});
export type WorkItemRef = z.infer<typeof workItemRefSchema>;

export const forgeSubjectRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issue'), ref: workItemRefSchema }),
  z.object({ kind: z.literal('pr'), ref: prRefSchema }),
]);
export type ForgeSubjectRef = z.infer<typeof forgeSubjectRefSchema>;

export const gitObjectIdSchema = nonEmpty;

export const sourceActorAccountTypeSchema = z.enum(['user', 'bot', 'organization']);
export type SourceActorAccountType = z.infer<typeof sourceActorAccountTypeSchema>;

/**
 * `type` is the forge account's kind. Null means the forge does not say or the kind is none of
 * these. It is absent from records written before it existed, so a reader treats absence as
 * unknown.
 */
export const sourceActorSchema = z.object({
  host: nonEmpty,
  id: nonEmpty,
  login: nonEmpty.nullable(),
  type: sourceActorAccountTypeSchema.nullable().optional(),
});
export type SourceActor = z.infer<typeof sourceActorSchema>;
