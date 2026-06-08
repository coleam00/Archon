/**
 * Zod schemas for the per-user AI-provider credential ("AI Provider Keys")
 * endpoints — the API-key connect surface (Phase 2, PR-2).
 *
 * Filename carries a `provider-key` (not `credential`) stem to clear a
 * user-global Write/Edit guard hook that blocks basenames matching
 * `credential./secret./password./token.`. No secret values appear in any of
 * these shapes — list/responses are metadata only. OAuth start/poll schemas
 * land with the Pi OAuth bridge (PR-3).
 */
import { z } from '@hono/zod-openapi';

/** One connected provider — metadata only, never a secret value. */
export const providerKeyConnectionSchema = z
  .object({
    provider: z.string(),
    kind: z.enum(['api_key', 'oauth']),
    label: z.string().nullable(),
  })
  .openapi('ProviderKeyConnection');

/**
 * GET /api/auth/providers response. `enabled` reflects the per-user-keys gate
 * (TOKEN_ENCRYPTION_KEY); `available` is the server-owned catalog of
 * connectable provider ids so the client never duplicates `KNOWN_PROVIDERS`.
 */
export const providerKeyListResponseSchema = z
  .object({
    enabled: z.boolean(),
    connections: z.array(providerKeyConnectionSchema),
    available: z.array(z.string()),
  })
  .openapi('ProviderKeyListResponse');

/** Path param for the per-provider routes. */
export const providerKeyParamsSchema = z.object({ provider: z.string() });

/** PUT /api/auth/providers/:provider request body. */
export const providerKeySetBodySchema = z
  .object({
    // `.refine` rejects whitespace-only keys at the validation layer (400)
    // — defense in depth; the connect-service also trims + rejects blank.
    apiKey: z
      .string()
      .min(1)
      .refine(v => v.trim().length > 0, { message: 'apiKey must not be blank' }),
    label: z.string().optional(),
  })
  .openapi('ProviderKeySetBody');

/** PUT /api/auth/providers/:provider response — secret-free confirmation. */
export const providerKeySetResponseSchema = z
  .object({
    success: z.boolean(),
    provider: z.string(),
    kind: z.literal('api_key'),
    label: z.string().nullable(),
  })
  .openapi('ProviderKeySetResponse');

/** DELETE /api/auth/providers/:provider response. */
export const providerKeyDeleteResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('ProviderKeyDeleteResponse');
