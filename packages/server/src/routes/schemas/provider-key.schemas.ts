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
import { CREDENTIAL_KINDS } from '@archon/providers';

/** One connected provider — metadata only, never a secret value. */
export const providerKeyConnectionSchema = z
  .object({
    provider: z.string(),
    kind: z.enum(['api_key', 'oauth']),
    label: z.string().nullable(),
  })
  .openapi('ProviderKeyConnection');

/**
 * One credential a given agent can consume, with the caller's connection
 * state and server-side detection (install env / ambient). No secret values.
 *
 * Hand-synced with `AgentCredentialStatus` in
 * `@archon/core/credentials/catalog.ts` — the type lives in core (which can't
 * own route schemas) and the schema lives here; update both together.
 */
export const agentCredentialStatusSchema = z
  .object({
    vendor: z.string(),
    displayName: z.string(),
    kinds: z.array(z.enum(CREDENTIAL_KINDS)),
    connected: z.enum(['api_key', 'oauth']).nullable(),
    subscriptionAvailable: z.boolean(),
    installEnv: z.boolean(),
    ambientConfigured: z.boolean().optional(),
  })
  .openapi('AgentCredentialStatus');

/**
 * One agent's credential surface. `catalog: 'dynamic'` (OpenCode) means the
 * vendor set is resolved at runtime via the agent's own introspection
 * endpoint; `credentials` is empty and `ready` is always false for those.
 *
 * Hand-synced with `AgentCredentialMatrixEntry` in
 * `@archon/core/credentials/catalog.ts` — update both together.
 */
export const agentCredentialsSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    catalog: z.enum(['static', 'dynamic']),
    ready: z.boolean(),
    credentials: z.array(agentCredentialStatusSchema),
  })
  .openapi('AgentCredentials');

/**
 * GET /api/auth/providers response. `enabled` reflects the per-user-keys gate
 * (TOKEN_ENCRYPTION_KEY); `available` is the server-owned catalog of
 * connectable vendor ids (registry-derived) so the client never duplicates
 * it; `agents` is the agent → credential matrix (#1955) the console settings
 * cards render from.
 */
export const providerKeyListResponseSchema = z
  .object({
    enabled: z.boolean(),
    connections: z.array(providerKeyConnectionSchema),
    available: z.array(z.string()),
    /** Subset of vendors that support subscription (OAuth) login. */
    subscriptionAvailable: z.array(z.string()),
    agents: z.array(agentCredentialsSchema),
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
