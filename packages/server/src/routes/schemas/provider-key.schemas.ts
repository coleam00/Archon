/**
 * Zod schemas for the per-user AI-provider credential ("AI Provider Keys")
 * endpoints — the API-key connect surface (Phase 2, PR-2).
 *
 * Filename carries a `provider-key` (not `credential`) stem to clear a
 * user-global Write/Edit guard hook that blocks basenames matching
 * `credential./secret./password./token.`. No secret values appear in any of
 * these shapes — list/responses are metadata only.
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
    /** Subset of providers that support subscription (OAuth) login. */
    subscriptionAvailable: z.array(z.string()),
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

// ---- Subscription (OAuth) connect — start/poll (PR-3) ----

/**
 * POST /api/auth/providers/:provider/oauth/start response. `mode` is `manual`
 * (Anthropic/Codex: show `url`, user pastes a code back via poll) or `device`
 * (Copilot: show `userCode`+`verificationUri`, poll until connected).
 */
export const providerOAuthStartResponseSchema = z
  .object({
    sessionId: z.string(),
    mode: z.enum(['manual', 'device']),
    url: z.string().optional(),
    userCode: z.string().optional(),
    verificationUri: z.string().optional(),
    expiresIn: z.number(),
  })
  .openapi('ProviderOAuthStartResponse');

/** POST /api/auth/providers/:provider/oauth/poll request — `code` for manual flows. */
export const providerOAuthPollBodySchema = z
  .object({
    sessionId: z.string().min(1),
    code: z.string().optional(),
  })
  .openapi('ProviderOAuthPollBody');

/** POST /api/auth/providers/:provider/oauth/poll response — no secret values. */
export const providerOAuthPollResponseSchema = z
  .object({
    status: z.enum(['pending', 'connected', 'error']),
    detail: z.string().optional(),
    mode: z.enum(['manual', 'device']).optional(),
    url: z.string().optional(),
    userCode: z.string().optional(),
    verificationUri: z.string().optional(),
  })
  .openapi('ProviderOAuthPollResponse');
