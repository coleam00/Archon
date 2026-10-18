import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  getUserAiPrefs,
  setUserTiers,
  setUserAliases,
  setUserDefault,
  type UserTiersPatch,
  type UserAliasesPatch,
} from '@archon/core';
import { missingProviderMessage } from '@archon/provider-contract';
import { isRegisteredProvider, providerRegistry } from '@archon/providers';
import { TIER_NAMES } from '@archon/workflows/model-validation';
import { validateAliasName } from './alias-name';
import { toCleanEntry, validatePresetEntry } from './api-preset-entry';
import { requireWebUser } from './api-request-auth';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import {
  userAiPrefsResponseSchema,
  updateUserTiersBodySchema,
  updateUserAliasesBodySchema,
  updateUserDefaultBodySchema,
} from './schemas/user-ai-prefs.schemas';

const userAiPrefsGetRoute = createRoute({
  method: 'get',
  path: '/api/auth/me/ai-prefs',
  tags: ['Auth'],
  summary: 'Get the current web user’s AI preferences (tiers/aliases/default assistant)',
  responses: {
    200: {
      content: { 'application/json': { schema: userAiPrefsResponseSchema } },
      description: 'The user’s stored prefs (raw per-user layer, not merged with config)',
    },
    401: jsonError('Web auth required'),
    500: jsonError('Server error'),
  },
});

const userAiPrefsTiersRoute = createRoute({
  method: 'patch',
  path: '/api/auth/me/ai-prefs/tiers',
  tags: ['Auth'],
  summary: 'Update the current web user’s model-tier presets (per-key merge; null unsets)',
  request: {
    body: {
      content: { 'application/json': { schema: updateUserTiersBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: userAiPrefsResponseSchema } },
      description: 'Updated prefs',
    },
    400: jsonError('Unknown provider or invalid effort'),
    401: jsonError('Web auth required'),
    500: jsonError('Server error'),
  },
});

const userAiPrefsAliasesRoute = createRoute({
  method: 'patch',
  path: '/api/auth/me/ai-prefs/aliases',
  tags: ['Auth'],
  summary: 'Update the current web user’s @custom aliases (per-key merge; null unsets)',
  request: {
    body: {
      content: { 'application/json': { schema: updateUserAliasesBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: userAiPrefsResponseSchema } },
      description: 'Updated prefs',
    },
    400: jsonError('Invalid alias name, unknown provider, or invalid effort'),
    401: jsonError('Web auth required'),
    500: jsonError('Server error'),
  },
});

const userAiPrefsDefaultRoute = createRoute({
  method: 'patch',
  path: '/api/auth/me/ai-prefs/default',
  tags: ['Auth'],
  summary:
    'Set (or clear with null) the current web user’s default assistant + default chat model (written atomically; omitted model clears any pin)',
  request: {
    body: {
      content: { 'application/json': { schema: updateUserDefaultBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: userAiPrefsResponseSchema } },
      description: 'Updated prefs',
    },
    400: jsonError('Unknown provider'),
    401: jsonError('Web auth required'),
    500: jsonError('Server error'),
  },
});

export function registerUserAiPrefsRoutes(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // ---- Per-user AI preferences (Phase 3) ----
  // Identity-gated (requireWebUser) but NOT gated on TOKEN_ENCRYPTION_KEY —
  // prefs are model names, not secrets. Highest-precedence resolver layer.

  registerOpenApiRoute(userAiPrefsGetRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to read AI preferences');
    if ('error' in web) return web.error;
    try {
      return c.json(await getUserAiPrefs(web.userId));
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.user_ai_prefs_get_failed');
      return apiError(c, 500, 'Failed to read AI preferences');
    }
  });

  registerOpenApiRoute(userAiPrefsTiersRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to update AI preferences');
    if ('error' in web) return web.error;
    const body = getValidatedBody(c, updateUserTiersBodySchema);
    const patch: UserTiersPatch = {};
    for (const tier of TIER_NAMES) {
      const entry = body.tiers[tier];
      if (entry === undefined) continue;
      if (entry === null) {
        patch[tier] = null;
        continue;
      }
      const errMsg = validatePresetEntry(`tier '${tier}'`, entry);
      if (errMsg) return apiError(c, 400, errMsg);
      patch[tier] = toCleanEntry(entry);
    }
    try {
      await setUserTiers(web.userId, patch);
      return c.json(await getUserAiPrefs(web.userId));
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.user_ai_prefs_tiers_failed');
      return apiError(c, 500, 'Failed to update AI tier preferences');
    }
  });

  registerOpenApiRoute(userAiPrefsAliasesRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to update AI preferences');
    if ('error' in web) return web.error;
    const body = getValidatedBody(c, updateUserAliasesBodySchema);
    const patch: UserAliasesPatch = {};
    for (const [name, entry] of Object.entries(body.aliases)) {
      const nameErr = validateAliasName(name);
      if (nameErr) return apiError(c, 400, nameErr);
      if (entry === null) {
        patch[name] = null;
        continue;
      }
      const errMsg = validatePresetEntry(`alias '${name}'`, entry);
      if (errMsg) return apiError(c, 400, errMsg);
      patch[name] = toCleanEntry(entry);
    }
    try {
      await setUserAliases(web.userId, patch);
      return c.json(await getUserAiPrefs(web.userId));
    } catch (err) {
      getLog().error(
        { err: err as Error, userId: web.userId },
        'auth.user_ai_prefs_aliases_failed'
      );
      return apiError(c, 500, 'Failed to update AI alias preferences');
    }
  });

  registerOpenApiRoute(userAiPrefsDefaultRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to update AI preferences');
    if ('error' in web) return web.error;
    const { provider, model } = getValidatedBody(c, updateUserDefaultBodySchema);
    if (provider !== null && !isRegisteredProvider(provider)) {
      return apiError(c, 400, missingProviderMessage(providerRegistry, provider));
    }
    if (provider === null && typeof model === 'string') {
      return apiError(c, 400, 'Cannot set a default model without a default provider');
    }
    try {
      // Atomic write: provider + model always land together — an omitted
      // model clears any previous pin so it can't ride a provider switch.
      await setUserDefault(web.userId, provider, model ?? null);
      return c.json(await getUserAiPrefs(web.userId));
    } catch (err) {
      getLog().error(
        { err: err as Error, userId: web.userId },
        'auth.user_ai_prefs_default_failed'
      );
      return apiError(c, 500, 'Failed to update default assistant preference');
    }
  });
}
