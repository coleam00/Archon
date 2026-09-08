import { z } from 'zod';
export const repoRefSchema = z.object({
  host: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  path: z
    .string()
    .regex(/^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+$/u)
    .refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
});
export type RepoRef = z.infer<typeof repoRefSchema>;
export const prRefSchema = z.object({ repo: repoRefSchema, number: z.number().int().positive() });
export type PrRef = z.infer<typeof prRefSchema>;
export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
