import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

export const repoRefSchema = z.object({
  host: nonEmpty,
  path: nonEmpty,
});
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

export const sourceActorSchema = z.object({
  host: nonEmpty,
  id: nonEmpty,
  login: nonEmpty.nullable(),
});
export type SourceActor = z.infer<typeof sourceActorSchema>;
