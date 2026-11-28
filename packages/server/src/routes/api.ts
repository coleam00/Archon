import type { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { loadConfig, type CloneOptions, type ConversationLockManager } from '@archon/core';
import { webPushPayloadSchema } from '@archon/core/schemas/web-push';
import {
  createSqlWorkflowHost,
  createSqlWorkflowOperations,
} from '@archon/core/workflows/sql-host';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
import * as codebaseDb from '@archon/core/db/codebases';
import {
  registeredProjectForPath,
  registeredProjectKeyForPath,
} from '@archon/core/services/codebase-checkout-resolver';
import { readPackGraph } from '@archon/core/workflows/pack-graph';
import { getTriggersPath, launchProjectKey } from '@archon/core/workflows/run-ended';
import { providerRegistry } from '@archon/providers';
import { resolveWorkflowGithubEnvironment } from '@archon/workflows/run-credential-env';
import type { WebAdapter } from '../adapters/web';
import { dagNodeSseEventSchema } from '../adapters/web/workflow-event.schemas';
import { isApiGateEnabled } from '../auth';
import type { AttentionRouter } from '../services/attention-router';
import { createProjectForgeReader, hostForgeAccess } from '../services/project-forge';
import type { ItemTracker } from '@archon/adapters/item-tracker/item-tracker';
import type { WebPushDestination } from '../services/web-push';
import { createOrchestratorDispatch } from './api-message-dispatch';
import { requireWebUser, resolveAuthContext, resolveWebUserId } from './api-request-auth';
import { registerArtifactRoutes } from './api.artifacts';
import { registerAuthRoutes } from './api.auth';
import { registerCodebaseEnvironmentRoute, registerCodebaseRoutes } from './api.codebases';
import { registerConfigRoutes } from './api.config';
import { registerConversationRoutes } from './api.conversations';
import { registerConversationProcessingRoute } from './api.conversation-processing';
import { registerProjectForgeRoute } from './api.forge';
import { registerHealthRoutes } from './api.health';
import { registerItemRoutes } from './api.items';
import { registerMessageRoutes } from './api.messages';
import { registerMetricViewsRoute, registerMetricsRoute } from './api.metrics';
import { registerPackGraphRoute } from './api.packs';
import { registerProviderKeyRoutes } from './api.provider-keys';
import { registerProviderRoutes } from './api.providers';
import { registerAttentionStreamRoute, registerRunAttentionRoutes } from './api.run-attention';
import { registerRunCleanupRoutes, registerRunControlRoutes } from './api.run-control';
import { registerRunGateRoutes } from './api.run-gates';
import { registerUserAiPrefsRoutes } from './api.user-ai-prefs';
import { registerWebPushRoutes } from './api.web-push';
import { registerWorkflowRunLaunchRoute } from './api.workflow-run-launch';
import { registerDashboardRunsRoute, registerWorkflowRunReadRoutes } from './api.workflow-runs';
import { registerWorkflowDefinitionRoutes, registerWorkflowListRoute } from './api.workflows';
import type { AppCommit } from './schemas/system.schemas';
import { RUN_ATTENTION_SCHEMA_NAME, runAttentionSchema } from './schemas/workflow.schemas';

/**
 * Register all /api/* routes on the Hono app, one registrar per area.
 *
 * The registrar call order is the order of `paths` in the OpenAPI document and in the
 * generated web client types, so `check:api-types` fails on any reorder. Each module
 * keeps its own Hono match-order constraints beside the routes they order.
 */
export function registerApiRoutes(
  app: OpenAPIHono,
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager,
  activePlatforms?: readonly string[],
  attention?: {
    webPush: WebPushDestination;
    router: AttentionRouter;
    tracker?: Pick<ItemTracker, 'health'>;
  },
  registration: Pick<CloneOptions, 'githubAppAuth'> = {},
  commit?: AppCommit
): void {
  const operations = createSqlWorkflowOperations();
  const dispatchToOrchestrator = createOrchestratorDispatch(webAdapter, lockManager);

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
  registerConversationRoutes(app, { webAdapter, dispatchToOrchestrator });
  registerMessageRoutes(app, { webAdapter, dispatchToOrchestrator, lockManager });
  registerCodebaseRoutes(app, registration);

  app.doc('/api/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Archon API', version: '1.0.0' },
  });

  registerWorkflowListRoute(app);
  registerWorkflowRunLaunchRoute(app, { webAdapter, dispatchToOrchestrator });
  registerRunAttentionRoutes(app, operations);
  registerItemRoutes(app);
  // A host per stream keeps registration free of I/O; the API-types generator registers too.
  registerAttentionStreamRoute(app, (listener, options) =>
    createSqlWorkflowHost().engine.watchAttention(listener, options)
  );
  registerDashboardRunsRoute(app);
  registerConversationProcessingRoute(app, { lockManager });
  registerRunControlRoutes(app, { operations, dispatchToOrchestrator });
  registerRunGateRoutes(app, operations);
  registerRunCleanupRoutes(app, operations);
  registerWorkflowRunReadRoutes(app);
  registerMetricsRoute(app, createWorkflowStore());
  registerMetricViewsRoute(app, {
    codebaseCwd: async id => (await codebaseDb.getCodebase(id))?.default_cwd ?? null,
    loadConfig,
  });
  registerPackGraphRoute(app, {
    codebaseCwd: async id => (await codebaseDb.getCodebase(id))?.default_cwd ?? null,
    readPackGraph: (cwd, pack, workflowSource) =>
      readPackGraph(
        cwd,
        pack,
        {
          loadConfig,
          providers: providerRegistry,
          triggersDirectory: getTriggersPath,
          projectKeyOf: launchProjectKey(path => registeredProjectKeyForPath(path, codebaseDb)),
          projectOf: path => registeredProjectForPath(path, codebaseDb),
        },
        workflowSource === undefined ? {} : { workflowSource }
      ),
  });
  registerWorkflowDefinitionRoutes(app);
  registerArtifactRoutes(app);
  registerConfigRoutes(app);
  registerProviderRoutes(app);
  registerCodebaseEnvironmentRoute(app);
  registerProjectForgeRoute(app, {
    getCodebase: codebaseDb.getCodebase,
    userId: resolveWebUserId,
    readProjectForge: createProjectForgeReader({
      ...hostForgeAccess(),
      // The credential a run for this user on this project would get: the App installation
      // token, the user's own token, or the per-user scrub. The shared token is never borrowed.
      credentialEnv: async (codebase, userId) => ({
        ...process.env,
        ...(
          await resolveWorkflowGithubEnvironment(createSqlWorkflowHost().deps, codebase, userId, {
            envVars: {},
          })
        ).envVars,
      }),
      now: () => new Date(),
    }),
  });
  registerWebPushRoutes(app, attention);
  registerHealthRoutes(app, { lockManager, activePlatforms, attention, commit });
}
