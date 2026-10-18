import { WebPushDestination } from '../services/web-push';
import { PUSH_DESTINATION_STATES, type AttentionRouter } from '../services/attention-router';
import { deleteWebPushSubscription } from '@archon/core/db/web-push-subscriptions';
import {
  webPushSubscriptionSchema,
  webPushDeleteSchema,
  webPushKeySchema,
  webPushSuccessSchema,
  webPushPayloadSchema,
} from '@archon/core/schemas/web-push';
/**
 * REST API routes for the Archon Web UI.
 * Provides conversation, codebase, and SSE streaming endpoints.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import type { WebAdapter } from '../adapters/web';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ConversationLockManager, SchemaVersionInfo } from '@archon/core';
import { getSchemaVersion, type CloneOptions } from '@archon/core';
import {
  isDocker,
  isWSL,
  getWSLDistroName,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
} from '@archon/paths';
import { apiError, getLog, getValidatedBody, openApiRouteRegistrar } from './api-route-kit';
import { requireWebUser, resolveAuthContext } from './api-request-auth';
import { createOrchestratorDispatch } from './api-message-dispatch';
import { registerAuthRoutes } from './api.auth';
import { registerProviderKeyRoutes } from './api.provider-keys';
import { registerConversationRoutes } from './api.conversations';
import { registerMessageRoutes } from './api.messages';
import { registerCodebaseEnvironmentRoute, registerCodebaseRoutes } from './api.codebases';
import { registerUserAiPrefsRoutes } from './api.user-ai-prefs';
import { registerWorkflowDefinitionRoutes, registerWorkflowListRoute } from './api.workflows';
import { registerWorkflowRunLaunchRoute } from './api.workflow-run-launch';
import { registerRunAttentionRoutes } from './api.run-attention';
import { registerDashboardRunsRoute, registerWorkflowRunReadRoutes } from './api.workflow-runs';
import { registerRunCleanupRoutes, registerRunControlRoutes } from './api.run-control';
import { registerRunGateRoutes } from './api.run-gates';
import { registerArtifactRoutes } from './api.artifacts';
import { registerConfigRoutes } from './api.config';
import { registerProviderRoutes } from './api.providers';
import * as workflowDb from '@archon/core/db/workflows';
import { createSqlWorkflowOperations } from '@archon/core/workflows/sql-host';
import { isApiGateEnabled } from '../auth';
import { updateCheckResponseSchema } from './schemas/system.schemas';
import { dagNodeSseEventSchema } from '../adapters/web/workflow-event.schemas';
import { runAttentionSchema, RUN_ATTENTION_SCHEMA_NAME } from './schemas/workflow.schemas';

// Read app version: use build-time constant in binary, package.json in dev
let appVersion = 'unknown';
if (BUNDLED_IS_BINARY) {
  appVersion = BUNDLED_VERSION;
} else {
  try {
    const pkgContent = readFileSync(join(import.meta.dir, '../../../../package.json'), 'utf-8');
    const pkg = JSON.parse(pkgContent) as { version?: string };
    appVersion = pkg.version ?? 'unknown';
  } catch (err) {
    getLog().debug(
      { err, path: join(import.meta.dir, '../../../../package.json') },
      'api.version_read_failed'
    );
  }
}

// =========================================================================
// Config / health route configs
// =========================================================================

const getWebPushKeyRoute = createRoute({
  method: 'get',
  path: '/api/web-push/key',
  tags: ['Alerts'],
  summary: 'Browser push public key',
  responses: {
    200: {
      content: { 'application/json': { schema: webPushKeySchema } },
      description: 'VAPID public key',
    },
  },
});
const addWebPushRoute = createRoute({
  method: 'post',
  path: '/api/web-push/subscriptions',
  tags: ['Alerts'],
  summary: 'Opt this browser into push',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: webPushSubscriptionSchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: webPushSuccessSchema } },
      description: 'Subscribed',
    },
  },
});
const deleteWebPushRoute = createRoute({
  method: 'delete',
  path: '/api/web-push/subscriptions',
  tags: ['Alerts'],
  summary: 'Opt this browser out of push',
  request: {
    body: { required: true, content: { 'application/json': { schema: webPushDeleteSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: webPushSuccessSchema } },
      description: 'Unsubscribed',
    },
  },
});

/**
 * Conversation concurrency as `GET /api/health` reports it: the lock manager's
 * stats, with `active` widened to include background workflow conversations.
 * `satisfies` ties the declared fields to `getStats()`, so a rename there fails
 * the type-check instead of reaching the console as a missing field.
 */
const healthConcurrencySchema = z.object({
  active: z.number(),
  queuedTotal: z.number(),
  queuedByConversation: z.array(
    z.object({ conversationId: z.string(), queuedMessages: z.number() })
  ),
  maxConcurrent: z.number(),
  activeConversationIds: z.array(z.string()),
}) satisfies z.ZodType<ReturnType<ConversationLockManager['getStats']>>;

const getHealthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['System'],
  summary: 'Health check',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z
            .object({
              status: z.string(),
              adapter: z.string(),
              concurrency: healthConcurrencySchema,
              runningWorkflows: z.number(),
              version: z.string().optional(),
              is_docker: z.boolean(),
              is_wsl: z.boolean(),
              wsl_distro: z.string().optional(),
              activePlatforms: z.array(z.string()).optional(),
              attentionDestinations: z
                .array(z.object({ id: z.string(), state: z.enum(PUSH_DESTINATION_STATES) }))
                .optional(),
              // Schema vintage (#2316) so a bug report can state which Archon build
              // created this database and which last applied schema to it. Omitted
              // when unrecorded or unreadable — health must answer regardless.
              schema: z
                .object({
                  createdAppVersion: z.string().nullable(),
                  appVersion: z.string(),
                  appliedAt: z.string().nullable(),
                })
                .optional(),
            })
            .openapi('HealthResponse'),
        },
      },
      description: 'Health status',
    },
  },
});

const getUpdateCheckRoute = createRoute({
  method: 'get',
  path: '/api/update-check',
  tags: ['System'],
  summary: 'Check for available updates',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: updateCheckResponseSchema,
        },
      },
      description: 'Update check result',
    },
  },
});

/**
 * Register all /api/* routes on the Hono app.
 */
export function registerApiRoutes(
  app: OpenAPIHono,
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager,
  activePlatforms?: readonly string[],
  attention?: { webPush: WebPushDestination; router: AttentionRouter },
  registration: Pick<CloneOptions, 'githubAppAuth'> = {}
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);
  const operations = createSqlWorkflowOperations();

  app.openAPIRegistry.register('DagNodeSseEvent', dagNodeSseEventSchema);
  app.openAPIRegistry.register('WebPushPayload', webPushPayloadSchema);
  app.openAPIRegistry.register(RUN_ATTENTION_SCHEMA_NAME, runAttentionSchema);

  // CORS for Web UI — allow-all is fine for a single-developer tool.
  // Override with WEB_UI_ORIGIN env var to restrict if exposing publicly.
  app.use('/api/*', cors({ origin: process.env.WEB_UI_ORIGIN || '*' }));

  // Server-side access gate: when web auth is enabled (and not opted out via
  // ARCHON_WEB_AUTH_REQUIRED=false), every /api/* request must resolve to an
  // identity or get 401 — this is what makes Better Auth the real access
  // boundary so a reverse-proxy auth sidecar can retire. Public exceptions:
  //   - /api/auth/* — the login/status/device-flow surface (can't gate login)
  //   - /api/health* — the Docker/uptime healthcheck MUST stay reachable
  // /webhooks/* (HMAC-verified) and /internal/* (loopback-guarded) are outside
  // /api/* and untouched. No-op when web auth is disabled (solo/local unchanged).
  //
  // SECURITY: resolveAuthContext also accepts the trusted reverse-proxy header
  // (`webAuthHeaderName()`) as an identity. That header
  // is only safe to trust when the app is reachable solely through a proxy that
  // STRIPS it from inbound requests (or the app binds 127.0.0.1). If you retire
  // the proxy auth sidecar, the proxy MUST still strip that header — otherwise a
  // client can forge it and walk straight through this gate.
  const PUBLIC_API_GATE_PREFIXES = ['/api/auth/', '/api/health'];
  app.use('/api/*', async (c, next) => {
    if (!isApiGateEnabled()) return next();
    const path = c.req.path;
    if (PUBLIC_API_GATE_PREFIXES.some(p => path === p || path.startsWith(p))) return next();
    if (await resolveAuthContext(c)) return next();
    // Soft resolution reads an identity-backend outage as "signed out"; the strict
    // path tells the two apart so an outage is a 503, not a 401.
    const strict = await requireWebUser(c, 'Authentication required');
    return 'error' in strict ? strict.error : next();
  });

  registerAuthRoutes(app);
  registerProviderKeyRoutes(app);
  registerUserAiPrefsRoutes(app);

  const dispatchToOrchestrator = createOrchestratorDispatch(webAdapter, lockManager);
  registerConversationRoutes(app, { webAdapter, dispatchToOrchestrator });
  registerMessageRoutes(app, { webAdapter, dispatchToOrchestrator });
  registerCodebaseRoutes(app, registration);

  // Serve OpenAPI spec
  app.doc('/api/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Archon API', version: '1.0.0' },
  });

  // =========================================================================
  // Workflow endpoints
  // =========================================================================

  registerWorkflowListRoute(app);

  registerWorkflowRunLaunchRoute(app, { webAdapter, dispatchToOrchestrator });

  registerRunAttentionRoutes(app, operations);

  registerDashboardRunsRoute(app);

  registerRunControlRoutes(app, { operations, dispatchToOrchestrator });

  registerRunGateRoutes(app, operations);

  registerRunCleanupRoutes(app, operations);

  registerWorkflowRunReadRoutes(app);

  registerWorkflowDefinitionRoutes(app);

  registerArtifactRoutes(app);

  registerConfigRoutes(app);

  registerProviderRoutes(app);

  registerCodebaseEnvironmentRoute(app);

  const webPush = attention?.webPush ?? new WebPushDestination();
  registerOpenApiRoute(getWebPushKeyRoute, c => c.json({ publicKey: webPush.publicKey() }));
  registerOpenApiRoute(addWebPushRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      await webPush.subscribe(web.userId, getValidatedBody(c, webPushSubscriptionSchema));
      return c.json({ success: true as const });
    } catch (err) {
      getLog().error(
        {
          err: {
            name: err instanceof Error ? err.name : 'UnknownError',
            code: err instanceof Error && 'code' in err ? err.code : undefined,
          },
        },
        'web_push.subscribe_failed'
      );
      return apiError(c, 500, 'Could not subscribe this browser');
    }
  });
  registerOpenApiRoute(deleteWebPushRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      await deleteWebPushSubscription(
        getValidatedBody(c, webPushDeleteSchema).endpoint,
        web.userId
      );
      return c.json({ success: true as const });
    } catch (err) {
      getLog().error(
        {
          err: {
            name: err instanceof Error ? err.name : 'UnknownError',
            code: err instanceof Error && 'code' in err ? err.code : undefined,
          },
        },
        'web_push.unsubscribe_failed'
      );
      return apiError(c, 500, 'Could not unsubscribe this browser');
    }
  });

  // GET /api/health - Health check with web adapter info
  registerOpenApiRoute(getHealthRoute, async c => {
    const stats = lockManager.getStats();
    const runningWorkflowRows = await workflowDb.getRunningWorkflows();

    // Merge lock-based and DB-based active tracking.
    // Background workflows bypass the lock manager, so we combine both sources.
    const lockActiveSet = new Set(stats.activeConversationIds);
    const backgroundConversationIds = runningWorkflowRows
      .map(r => r.conversation_id)
      .filter((id): id is string => id !== null && !lockActiveSet.has(id));
    const allActiveIds = [...stats.activeConversationIds, ...backgroundConversationIds];
    const wslDistro = getWSLDistroName();

    // Health is public (PUBLIC_API_GATE_PREFIXES) and must stay answerable when the
    // database is degraded, so a failed vintage read is logged and the key omitted
    // rather than turning the healthcheck into a 500. `createdAt` is deliberately not
    // exposed — the two version strings plus applied_at are what a bug report needs.
    let schema:
      | Pick<SchemaVersionInfo, 'createdAppVersion' | 'appVersion' | 'appliedAt'>
      | undefined;
    try {
      const info = await getSchemaVersion();
      if (info) {
        schema = {
          createdAppVersion: info.createdAppVersion,
          appVersion: info.appVersion,
          appliedAt: info.appliedAt,
        };
      }
    } catch (err) {
      getLog().warn({ err }, 'api.schema_version_read_failed');
    }

    const concurrency: z.infer<typeof healthConcurrencySchema> = {
      ...stats,
      active: allActiveIds.length,
      activeConversationIds: allActiveIds,
    };
    return c.json({
      status: 'ok',
      adapter: 'web',
      concurrency,
      runningWorkflows: runningWorkflowRows.length,
      version: appVersion,
      is_docker: isDocker(),
      is_wsl: isWSL(),
      ...(wslDistro ? { wsl_distro: wslDistro } : {}),
      activePlatforms: activePlatforms ? [...activePlatforms] : ['Web'],
      ...(attention ? { attentionDestinations: attention.router.health() } : {}),
      ...(schema ? { schema } : {}),
    });
  });

  registerOpenApiRoute(getUpdateCheckRoute, async c => {
    const noUpdate = {
      updateAvailable: false,
      currentVersion: appVersion,
      latestVersion: appVersion,
      releaseUrl: '',
    };
    if (!BUNDLED_IS_BINARY) return c.json(noUpdate);
    const result = await checkForUpdate(appVersion);
    return c.json(result ?? noUpdate);
  });
}
