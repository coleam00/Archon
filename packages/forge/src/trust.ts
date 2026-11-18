import { createHash } from 'node:crypto';
import { z } from 'zod';
import { forgeSubjectRefSchema, gitObjectIdSchema, sourceActorSchema } from './identity';

export const trustedTextScopeSchema = z.object({
  codebaseId: z.string().min(1),
  itemKey: z.string().min(1),
  input: z.string().min(1).optional(),
});

const path = z.string().min(1);
export const trustedTextPolicySchema = z.object({
  maintainersPath: path,
  head: gitObjectIdSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  maintainers: z.array(z.string().min(1)),
});
export type TrustedTextPolicy = z.infer<typeof trustedTextPolicySchema>;

export const trustedTextSchema = z.object({
  subject: forgeSubjectRefSchema,
  title: z.string(),
  body: z.string(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  author: sourceActorSchema.nullable().optional(),
  /** Actor who produced the current title/body, and when. Null means no edit. */
  editor: sourceActorSchema.nullable().optional(),
  lastEditedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /** Title edits have separate provenance; missing evidence must not inherit body trust. */
  titleEditor: sourceActorSchema.nullable().optional(),
  titleEditedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  policy: trustedTextPolicySchema,
});
export type TrustedText = z.infer<typeof trustedTextSchema>;
export const trustedTextAcceptanceSchema = trustedTextSchema.extend({
  acceptedBy: sourceActorSchema,
  scope: trustedTextScopeSchema,
});
export type TrustedTextAcceptance = z.infer<typeof trustedTextAcceptanceSchema>;

/** Exact source bytes, not normalized text: a one-byte edit is a new acceptance subject. */
export function trustedTextDigest(title: string, body: string): string {
  const hash = createHash('sha256');
  for (const value of [title, body]) {
    const bytes = Buffer.byteLength(value);
    hash.update(String(bytes));
    hash.update(':');
    hash.update(value);
  }
  return hash.digest('hex');
}

export function trustedActor(
  actor: { host: string; login?: string | null } | null | undefined,
  policy: TrustedTextPolicy
): boolean {
  return (
    actor !== null &&
    actor !== undefined &&
    actor.login !== undefined &&
    policy.maintainers.some(candidate => candidate.toLowerCase() === actor.login?.toLowerCase())
  );
}
