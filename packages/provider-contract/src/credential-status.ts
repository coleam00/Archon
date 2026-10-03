import { z } from 'zod';

/**
 * Where the checked credential comes from: one the user connected in Archon, or the
 * provider's own login on this machine (its CLI login, auth file or environment).
 */
export const credentialSourceSchema = z.enum(['archon', 'native']);
export type CredentialSource = z.infer<typeof credentialSourceSchema>;

/**
 * The vendor's or runtime's own words about why the credential cannot be used. Diagnostic
 * only: nothing may branch on it, because a vendor rewording must never change behaviour.
 * Never a credential value.
 */
const evidenceSchema = z.string().min(1);

/**
 * Whether a provider can authenticate, as its own runtime answered without sending a model
 * request:
 *  - `usable`         a credential resolved, and any refresh it needed succeeded. An API key
 *                     is usable once resolved; only a model request proves the vendor accepts it.
 *  - `not_connected`  this source holds no credential.
 *  - `unusable`       a credential exists but was rejected or cannot be read. The user must
 *                     reconnect or log in again.
 *  - `check_failed`   the check could not decide: a refresh failed for an unknown cause, the
 *                     vendor was unreachable, or the runtime failed unexpectedly. An unreachable
 *                     vendor is never reported as `unusable`.
 *  - `not_checked`    the provider cannot check without starting a model session.
 */
export const credentialStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('usable'), source: credentialSourceSchema }),
  z.object({ state: z.literal('not_connected'), source: credentialSourceSchema }),
  z.object({
    state: z.literal('unusable'),
    source: credentialSourceSchema,
    evidence: evidenceSchema,
  }),
  z.object({
    state: z.literal('check_failed'),
    source: credentialSourceSchema,
    evidence: evidenceSchema,
  }),
  z.object({ state: z.literal('not_checked'), source: credentialSourceSchema }),
]);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;
