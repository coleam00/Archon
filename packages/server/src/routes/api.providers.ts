import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { getAgentProvider } from '@archon/core/services/provider-admission';
import { getProviderInfoList } from '@archon/providers';
import { introspectOpencodeCredentials } from '@archon/providers/community/opencode';
import { apiError, getLog, jsonError, openApiRouteRegistrar } from './api-route-kit';
import {
  providerListResponseSchema,
  piModelListResponseSchema,
  opencodeCredentialListResponseSchema,
} from './schemas/provider.schemas';

const getPiModelsRoute = createRoute({
  method: 'get',
  path: '/api/providers/pi/models',
  tags: ['System'],
  summary: "List Pi's model catalog (cost/reasoning metadata for the tier picker)",
  description:
    'Best-effort hint surface: returns `{ models: [] }` when the Pi catalog ' +
    'cannot be loaded, never an error — tier/alias saves must not depend on it.',
  responses: {
    200: {
      content: { 'application/json': { schema: piModelListResponseSchema } },
      description: 'Pi model catalog (metadata only)',
    },
  },
});

const getProvidersRoute = createRoute({
  method: 'get',
  path: '/api/providers',
  tags: ['System'],
  summary: 'List registered AI providers',
  responses: {
    200: {
      content: { 'application/json': { schema: providerListResponseSchema } },
      description: 'List of registered providers',
    },
  },
});

const getOpencodeCredentialsRoute = createRoute({
  method: 'get',
  path: '/api/providers/opencode/credentials',
  tags: ['System'],
  summary: "Introspect OpenCode's backend providers and auth state",
  description:
    "Proxies the embedded OpenCode server's provider introspection (catalog, " +
    'env var names, install-wide connected state). Heavyweight: starts the ' +
    'embedded server when not already running — call on demand from the ' +
    'settings card, never on passive page load (#1955).',
  responses: {
    200: {
      content: { 'application/json': { schema: opencodeCredentialListResponseSchema } },
      description: 'OpenCode backend providers (metadata only, no secrets)',
    },
    503: jsonError('Embedded OpenCode runtime unavailable'),
  },
});

export function registerProviderRoutes(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/providers - List registered AI providers
  registerOpenApiRoute(getProvidersRoute, c => {
    return c.json({ providers: getProviderInfoList() });
  });

  // GET /api/providers/pi/models - Pi model catalog (best-effort hint; [] on failure)
  registerOpenApiRoute(getPiModelsRoute, async c => {
    try {
      const catalog = await getAgentProvider('pi').listModels?.({
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10_000)]),
      });
      const models = (catalog?.models ?? []).flatMap(model =>
        model.details
          ? [
              {
                ref: model.id,
                provider: model.details.provider,
                id: model.details.modelId,
                name: model.label ?? model.id,
                reasoning: model.details.reasoning,
                cost: model.details.cost,
                contextWindow: model.details.contextWindow,
              },
            ]
          : []
      );
      return c.json({ models });
    } catch (error) {
      // Model hints are best-effort; failure must not block the settings page.
      getLog().warn({ err: error }, 'providers.pi_models_list_failed');
      return c.json({ models: [] });
    }
  });

  // GET /api/providers/opencode/credentials - OpenCode backend introspection
  // (on-demand; starts the embedded runtime). 503 on failure — never a silent [].
  registerOpenApiRoute(getOpencodeCredentialsRoute, async c => {
    try {
      const result = await introspectOpencodeCredentials();
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'providers.opencode_credentials_introspect_failed');
      return apiError(c, 503, 'Embedded OpenCode runtime unavailable');
    }
  });
}
