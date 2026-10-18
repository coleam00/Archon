import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  isPerUserProviderKeysEnabled,
  persistProviderApiKey,
  InvalidProviderKeyError,
  listUserProviderKeys,
  deleteUserProviderKey,
  listConnectableVendors,
  buildAgentCredentialMatrix,
  normalizeCredentialVendor,
  SUBSCRIPTION_PROVIDERS,
  startOAuth,
  pollOAuth,
} from '@archon/core';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
  WEB_AUTH_REQUIRED,
} from './api-route-kit';
import { requireWebUser } from './api-request-auth';
import {
  providerKeyListResponseSchema,
  providerKeyParamsSchema,
  providerKeySetBodySchema,
  providerKeySetResponseSchema,
  providerKeyDeleteResponseSchema,
  providerOAuthStartResponseSchema,
  providerOAuthPollBodySchema,
  providerOAuthPollResponseSchema,
} from './schemas/provider-key.schemas';

const providerKeyListRoute = createRoute({
  method: 'get',
  path: '/api/auth/providers',
  tags: ['Auth'],
  summary: 'List the current web user’s connected AI-provider keys',
  responses: {
    200: {
      content: { 'application/json': { schema: providerKeyListResponseSchema } },
      description: 'Connections (metadata only) + connectable provider catalog',
    },
    401: WEB_AUTH_REQUIRED,
  },
});

const providerKeySetRoute = createRoute({
  method: 'put',
  path: '/api/auth/providers/{provider}',
  tags: ['Auth'],
  summary: 'Connect (upsert) an API key for a provider for the current web user',
  request: {
    params: providerKeyParamsSchema,
    body: { content: { 'application/json': { schema: providerKeySetBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: providerKeySetResponseSchema } },
      description: 'Key stored (encrypted); response carries no secret value',
    },
    400: jsonError('Unknown provider or empty key'),
    401: WEB_AUTH_REQUIRED,
    404: jsonError('Per-user provider keys not enabled on this install'),
  },
});

const providerKeyDeleteRoute = createRoute({
  method: 'delete',
  path: '/api/auth/providers/{provider}',
  tags: ['Auth'],
  summary: 'Disconnect the current web user’s key for a provider',
  request: { params: providerKeyParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: providerKeyDeleteResponseSchema } },
      description: 'Disconnected (idempotent)',
    },
    401: WEB_AUTH_REQUIRED,
    404: jsonError('Per-user provider keys not enabled on this install'),
  },
});

const providerOAuthStartRoute = createRoute({
  method: 'post',
  path: '/api/auth/providers/{provider}/oauth/start',
  tags: ['Auth'],
  summary: 'Begin a subscription (OAuth) login for the current web user',
  request: { params: providerKeyParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: providerOAuthStartResponseSchema } },
      description: 'Login session started (mode + URL/user-code)',
    },
    400: jsonError('Provider does not support subscription login'),
    401: WEB_AUTH_REQUIRED,
    404: jsonError('Per-user provider keys not enabled on this install'),
  },
});

const providerOAuthPollRoute = createRoute({
  method: 'post',
  path: '/api/auth/providers/{provider}/oauth/poll',
  tags: ['Auth'],
  summary: 'Poll a subscription login session (submit pasted code for manual flows)',
  request: {
    params: providerKeyParamsSchema,
    body: { content: { 'application/json': { schema: providerOAuthPollBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: providerOAuthPollResponseSchema } },
      description: 'Poll status',
    },
    401: WEB_AUTH_REQUIRED,
    404: jsonError('Per-user provider keys not enabled on this install'),
  },
});

export function registerProviderKeyRoutes(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // ---- Per-user AI-provider credential (API-key) connect endpoints ----
  // Gated on isPerUserProviderKeysEnabled() (TOKEN_ENCRYPTION_KEY). No response
  // carries a secret value: list/set return provider/kind/label only, delete
  // returns { success }.
  registerOpenApiRoute(providerKeyListRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to manage provider keys');
    if ('error' in web) return web.error;
    const available = listConnectableVendors();
    const subscriptionAvailable = [...SUBSCRIPTION_PROVIDERS].sort();
    if (!isPerUserProviderKeysEnabled()) {
      // Gate off: the console hides connect affordances on `enabled:false`;
      // the agents matrix still reports install-env/ambient readiness.
      return c.json({
        enabled: false,
        connections: [],
        available,
        subscriptionAvailable,
        agents: buildAgentCredentialMatrix([]),
      });
    }
    try {
      const connections = await listUserProviderKeys(web.userId);
      return c.json({
        enabled: true,
        connections,
        available,
        subscriptionAvailable,
        agents: buildAgentCredentialMatrix(connections),
      });
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.provider_keys_list_failed');
      return apiError(c, 500, 'Failed to list provider keys');
    }
  });

  registerOpenApiRoute(providerKeySetRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to manage provider keys');
    if ('error' in web) return web.error;
    if (!isPerUserProviderKeysEnabled()) {
      return apiError(c, 404, 'Per-user provider keys are not enabled on this install');
    }
    const provider = c.req.param('provider') ?? '';
    const { apiKey, label } = getValidatedBody(c, providerKeySetBodySchema);
    try {
      const result = await persistProviderApiKey(web.userId, provider, apiKey, label);
      return c.json({ success: true, ...result });
    } catch (err) {
      if (err instanceof InvalidProviderKeyError) {
        // Caller error (unknown provider / blank key) — the validation message is
        // safe to surface and carries no secret.
        return apiError(c, 400, err.message);
      }
      // Encryption / DB failure — opaque 500, never echo the internal message.
      getLog().error(
        { err: err as Error, userId: web.userId, provider },
        'auth.provider_key_set_failed'
      );
      return apiError(c, 500, 'Failed to store provider key');
    }
  });

  registerOpenApiRoute(providerKeyDeleteRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to manage provider keys');
    if ('error' in web) return web.error;
    if (!isPerUserProviderKeysEnabled()) {
      return apiError(c, 404, 'Per-user provider keys are not enabled on this install');
    }
    const provider = normalizeCredentialVendor(c.req.param('provider') ?? '');
    // No catalog check here (unlike PUT): delete is an idempotent no-op, so an
    // unknown/misspelled vendor id simply removes nothing and returns ok.
    // Legacy agent-keyed ids normalize so `DELETE .../claude` removes the
    // migrated `anthropic` row.
    try {
      await deleteUserProviderKey(web.userId, provider);
      return c.json({ success: true });
    } catch (err) {
      getLog().error(
        { err: err as Error, userId: web.userId, provider },
        'auth.provider_key_delete_failed'
      );
      return apiError(c, 500, 'Failed to disconnect provider key');
    }
  });

  // ---- Subscription (OAuth) connect: start + poll ----
  // The bridge holds Pi's in-flight login() server-side; start returns the URL/
  // user-code, poll(code?) feeds a pasted code (manual flows) and reports status.
  // No response carries a secret. Paths are under /api/auth/providers/ so they're
  // already exempt from the Better Auth catch-all (isArchonOwnedAuthPath).
  registerOpenApiRoute(providerOAuthStartRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect a subscription');
    if ('error' in web) return web.error;
    if (!isPerUserProviderKeysEnabled()) {
      return apiError(c, 404, 'Per-user provider keys are not enabled on this install');
    }
    // Normalize legacy agent-keyed ids ('claude' → 'anthropic') like every
    // other credential entry point — SUBSCRIPTION_PROVIDERS is vendor-keyed.
    const provider = normalizeCredentialVendor(c.req.param('provider') ?? '');
    if (!SUBSCRIPTION_PROVIDERS.has(provider)) {
      return apiError(
        c,
        400,
        `Provider '${provider}' does not support subscription login. ` +
          `Subscription providers: ${[...SUBSCRIPTION_PROVIDERS].sort().join(', ')}.`
      );
    }
    try {
      const start = await startOAuth(web.userId, provider);
      return c.json(start);
    } catch (err) {
      getLog().error(
        { err: err as Error, userId: web.userId, provider },
        'auth.provider_oauth_start_failed'
      );
      return apiError(c, 500, 'Failed to start subscription login');
    }
  });

  registerOpenApiRoute(providerOAuthPollRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect a subscription');
    if ('error' in web) return web.error;
    if (!isPerUserProviderKeysEnabled()) {
      return apiError(c, 404, 'Per-user provider keys are not enabled on this install');
    }
    // The `:provider` path segment only keeps the OAuth routes under one prefix
    // (so they're exempt from the Better Auth catch-all); poll itself keys off
    // sessionId + userId.
    const { sessionId, code } = getValidatedBody(c, providerOAuthPollBodySchema);
    // pollOAuth is bound to the session's userId, so a stranger's sessionId resolves
    // to an error status rather than another user's login.
    const result = pollOAuth(sessionId, web.userId, code);
    return c.json(result);
  });
}
