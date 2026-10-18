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
import { getAgentProvider } from '@archon/core/services/provider-admission';
import { missingProviderMessage } from '@archon/provider-contract';
/**
 * REST API routes for the Archon Web UI.
 * Provides conversation, codebase, and SSE streaming endpoints.
 */
import { providerRegistry } from '@archon/providers';

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import type { WebAdapter } from '../adapters/web';
import { readFile, readdir, realpath, stat } from 'fs/promises';
import { readFileSync } from 'fs';
import { normalize, join } from 'path';
import type { Context } from 'hono';
import type {
  ConversationLockManager,
  GlobalConfig,
  TiersPatch,
  SchemaVersionInfo,
} from '@archon/core';
import {
  getDatabaseType,
  getSchemaVersion,
  loadConfig,
  toSafeConfig,
  updateGlobalConfig,
  type CloneOptions,
} from '@archon/core';
import type { AliasesPatch } from '@archon/core';
import { InvalidConfigError } from '@archon/core/config';
import {
  getRunArtifactsDirForRoot,
  isRunArtifactsEngineEntry,
  resolveRunStorageRoot,
  isInsideArchonHome,
  isPathInside,
  getArchonHome,
  isDocker,
  isWSL,
  getWSLDistroName,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
} from '@archon/paths';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { requireWebUser, resolveAuthContext } from './api-request-auth';
import { createOrchestratorDispatch } from './api-message-dispatch';
import { toCleanEntry, validatePresetEntry } from './api-preset-entry';
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
import * as codebaseDb from '@archon/core/db/codebases';
import * as workflowDb from '@archon/core/db/workflows';
import { createSqlWorkflowOperations } from '@archon/core/workflows/sql-host';
import { isApiGateEnabled } from '../auth';
import { updateCheckResponseSchema } from './schemas/system.schemas';
import { listArtifactsResponseSchema } from './schemas/workflow.schemas';
import {
  updateAssistantConfigBodySchema,
  updateAssistantConfigResponseSchema,
  configResponseSchema,
  updateTiersBodySchema,
  updateAliasesBodySchema,
} from './schemas/config.schemas';
import { validateAliasName } from './alias-name';
import { TIER_NAMES } from '@archon/workflows/model-validation';
import {
  providerListResponseSchema,
  piModelListResponseSchema,
  opencodeCredentialListResponseSchema,
} from './schemas/provider.schemas';
import { getProviderInfoList, isRegisteredProvider } from '@archon/providers';
import { introspectOpencodeCredentials } from '@archon/providers/community/opencode';
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

/**
 * Resolve the on-disk artifact directory for a run, for EVERY project kind
 * (#2200).
 *
 * Both artifact routes previously did `parseOwnerRepo(codebase.name)` alone,
 * which returns null for a folder project (display name, no slash) and for a
 * no-remote local repo (bare basename) — so artifact browsing was silently dead
 * for two of the three project kinds Archon can register.
 *
 * The shared root resolver owns trusted persisted-root precedence and
 * relocation fallback; this route only composes the artifact directory.
 */
function resolveRunArtifactDir(
  run: { output_root?: string | null },
  codebase: { kind?: string | null; name: string; default_cwd: string } | null,
  runId: string
): string | null {
  const root = resolveRunStorageRoot(run, codebase);
  return root ? getRunArtifactsDirForRoot(root, runId) : null;
}

// =========================================================================
// Workflow run route configs
// =========================================================================

const listRunArtifactsRoute = createRoute({
  method: 'get',
  path: '/api/runs/{runId}/artifacts',
  tags: ['Workflows'],
  summary: "List a run's artifact files",
  description:
    "Walks the run's artifact directory and returns relative file paths with size + " +
    "mtime. Drives the console Artifacts tab. Leaves out only the engine's own " +
    '`.archon` child at the root, the same rule `archon workflow get` applies; a ' +
    "workflow's own dotfiles are listed. Resolves for every project kind — " +
    "`owner/repo`, `_local/<basename>`, and `_folder/<slug>` — preferring the run's " +
    'persisted `output_root` and re-deriving from the codebase when it is absent or ' +
    'no longer inside ARCHON_HOME. Returns `{ files: [] }` only when the location ' +
    'resolved and the run genuinely wrote nothing; returns 404 when the output ' +
    'location cannot be resolved at all.',
  request: {
    params: z.object({ runId: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: listArtifactsResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Config / health route configs
// =========================================================================

const getConfigRoute = createRoute({
  method: 'get',
  path: '/api/config',
  tags: ['System'],
  summary: 'Get read-only configuration (safe subset)',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: configResponseSchema,
        },
      },
      description: 'Configuration',
    },
    500: jsonError('Server error'),
  },
});

const patchAssistantConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/assistants',
  tags: ['System'],
  summary: 'Update assistant configuration',
  request: {
    body: {
      content: { 'application/json': { schema: updateAssistantConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: updateAssistantConfigResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError('Invalid request body, or the resulting config is invalid'),
    500: jsonError('Server error'),
  },
});

const patchTiersConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/tiers',
  tags: ['System'],
  summary: 'Update model-tier presets (small/medium/large)',
  description:
    'Writes the `tiers:` config to ~/.archon/config.yaml. Ungated (works on solo ' +
    'installs). Per-tier merge; a `null` tier value unsets it.',
  request: {
    body: {
      content: { 'application/json': { schema: updateTiersBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: configResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError('Invalid request body, or the resulting config is invalid'),
    500: jsonError('Server error'),
  },
});

const patchAliasesConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/aliases',
  tags: ['System'],
  summary: 'Update @custom model aliases',
  description:
    'Writes the `aliases:` config to ~/.archon/config.yaml. Ungated (works on solo ' +
    'installs). Per-alias merge; a `null` alias value unsets it.',
  request: {
    body: {
      content: { 'application/json': { schema: updateAliasesBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: configResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError(
      'Invalid alias name, unknown provider, invalid effort, or the resulting config is invalid'
    ),
    500: jsonError('Server error'),
  },
});

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

  // GET /api/runs/:runId/artifacts - List artifact files for a run.
  // Walks the run's artifact directory and returns relative file paths with
  // size + mtime. Used by the console's Artifacts tab; the existing
  // `workflow_artifact` event stream is too sparse (bash/script nodes write
  // straight to $ARTIFACTS_DIR without emitting an event) to drive a file
  // browser on its own.
  registerOpenApiRoute(listRunArtifactsRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      return apiError(c, 400, 'Invalid run id');
    }

    let run: Awaited<ReturnType<typeof workflowDb.getWorkflowRun>>;
    try {
      run = await workflowDb.getWorkflowRun(runId);
    } catch (error) {
      getLog().error({ err: error, runId }, 'artifacts.run_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }
    if (!run) return apiError(c, 404, 'Workflow run not found');

    let codebase: Awaited<ReturnType<typeof codebaseDb.getCodebase>> | null = null;
    if (run.codebase_id) {
      try {
        codebase = await codebaseDb.getCodebase(run.codebase_id);
      } catch (error) {
        getLog().error(
          { err: error, runId, codebaseId: run.codebase_id },
          'artifacts.codebase_lookup_failed'
        );
        return apiError(c, 500, 'Failed to look up codebase');
      }
    }
    // An empty 200 here is indistinguishable from "the run produced nothing",
    // so an unresolvable output location is an explicit 404 (Fail Fast).
    const artifactDir = resolveRunArtifactDir(run, codebase, runId);
    if (!artifactDir) {
      getLog().warn({ runId, codebaseId: run.codebase_id }, 'artifacts.output_location_unresolved');
      return apiError(
        c,
        404,
        'Artifacts not available: could not resolve this run’s output location'
      );
    }
    if (!isInsideArchonHome(artifactDir)) {
      getLog().warn(
        { runId, artifactDir, archonHome: getArchonHome() },
        'artifacts.path_escape_blocked'
      );
      return apiError(c, 400, 'Invalid artifact path');
    }

    interface FileEntry {
      path: string;
      size: number;
      modifiedAt: string;
    }
    const files: FileEntry[] = [];

    async function walk(dir: string, rel: string): Promise<void> {
      let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        // The engine's own store is left out by the rule the CLI's listing shares;
        // a workflow's own dotfiles are its output and stay listed.
        if (isRunArtifactsEngineEntry(rel, entry.name)) continue;
        const child = join(dir, entry.name);
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(child, childRel);
        } else if (entry.isFile()) {
          try {
            const s = await stat(child);
            files.push({
              path: childRel,
              size: s.size,
              modifiedAt: s.mtime.toISOString(),
            });
          } catch (err) {
            // Race with deletion / permission flips: skip ENOENT / EACCES
            // silently, surface anything else so we don't return a half-list
            // with no diagnostic.
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'EACCES') continue;
            throw err;
          }
        }
      }
    }

    try {
      await walk(artifactDir, '');
    } catch (error) {
      getLog().error({ err: error, runId, artifactDir }, 'artifacts.walk_failed');
      return apiError(c, 500, 'Failed to list artifacts');
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return c.json({ files });
  });

  // GET /api/artifacts/:runId/* - Serve workflow artifact file contents
  // The wildcard captures the filename (e.g. "plan.md", "subdir/report.md").
  // Path traversal is blocked: any segment containing ".." is rejected.
  // NOTE: Uses app.get() instead of registerOpenApiRoute because:
  //  1. Wildcard path params (*) are not representable in OpenAPI 3.0
  //  2. Response is raw text/markdown, not JSON
  app.get('/api/artifacts/:runId/*', async c => {
    const runId = c.req.param('runId');
    // Hono wildcards match but don't capture — extract filename from the URL path.
    // c.req.path is NOT percent-decoded, so we decode it manually.
    const prefix = `/api/artifacts/${runId}/`;
    const rawEncoded = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
    let rawFilename: string;
    try {
      rawFilename = decodeURIComponent(rawEncoded);
    } catch {
      return apiError(c, 400, 'Invalid filename');
    }

    // Block path traversal: reject if any segment is ".." or contains null bytes
    if (
      !rawFilename ||
      rawFilename.includes('\0') ||
      rawFilename.split('/').some(s => s === '..')
    ) {
      return apiError(c, 400, 'Invalid filename');
    }

    // Normalize and ensure relative (no leading slash)
    const filename = normalize(rawFilename).replace(/^[/\\]+/, '');
    if (!filename) {
      return apiError(c, 400, 'Invalid filename');
    }

    let run: Awaited<ReturnType<typeof workflowDb.getWorkflowRun>>;
    try {
      run = await workflowDb.getWorkflowRun(runId);
    } catch (error) {
      getLog().error({ err: error, runId }, 'artifacts.run_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }

    if (!run) {
      return apiError(c, 404, 'Workflow run not found');
    }

    // Resolve the run's output tree for every project kind — a persisted
    // output_root first, else the shared identity→paths resolver (#2200).
    const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
    const artifactDir = resolveRunArtifactDir(run, codebase, runId);
    if (!artifactDir) {
      getLog().error(
        { runId, codebaseId: run.codebase_id },
        'artifacts.output_location_unresolved'
      );
      return apiError(
        c,
        404,
        'Artifact not available: could not resolve this run’s output location'
      );
    }
    if (!isInsideArchonHome(artifactDir)) {
      getLog().warn(
        { runId, artifactDir, archonHome: getArchonHome() },
        'artifacts.path_escape_blocked'
      );
      return apiError(c, 400, 'Invalid artifact path');
    }
    const filePath = join(artifactDir, filename);

    // Final safety check: ensure resolved path stays within artifact directory
    if (!isPathInside(artifactDir, filePath, { includeRoot: true, lexical: true })) {
      getLog().warn({ runId, filename, filePath, artifactDir }, 'artifacts.path_escape_blocked');
      return apiError(c, 400, 'Invalid filename');
    }

    // readFile follows symlinks, so contain the resolved target within the
    // resolved artifact directory and read that checked path (#3160).
    let realArtifactDir: string;
    try {
      realArtifactDir = await realpath(artifactDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, 'Artifact file not found');
      }
      getLog().error({ err, runId, artifactDir }, 'artifacts.read_failed');
      return apiError(c, 500, 'Failed to read artifact file');
    }
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, 'Artifact file not found');
      }
      getLog().error({ err, runId, filename }, 'artifacts.read_failed');
      return apiError(c, 500, 'Failed to read artifact file');
    }
    if (!isPathInside(realArtifactDir, realFilePath, { includeRoot: true, lexical: true })) {
      getLog().warn(
        { runId, filename, realFilePath, realArtifactDir },
        'artifacts.symlink_escape_blocked'
      );
      return apiError(c, 404, 'Artifact file not found');
    }

    let content: string;
    try {
      content = await readFile(realFilePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, 'Artifact file not found');
      }
      getLog().error({ err, runId, filename }, 'artifacts.read_failed');
      return apiError(c, 500, 'Failed to read artifact file');
    }

    const contentType = filename.endsWith('.md')
      ? 'text/markdown; charset=utf-8'
      : 'text/plain; charset=utf-8';
    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  });

  // GET /api/config - Read-only configuration (safe subset only — no filesystem paths)
  registerOpenApiRoute(getConfigRoute, async c => {
    try {
      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_config_failed');
      return apiError(c, 500, 'Failed to get config');
    }
  });

  /**
   * A write the config validators refused is the caller's to fix: return it as a
   * 400 with the refused key. Anything else is a server fault and stays opaque.
   */
  function configUpdateFailed(
    c: Context,
    error: unknown,
    logEvent: string,
    message: string
  ): Response {
    if (error instanceof InvalidConfigError) {
      return apiError(c, 400, error.summary);
    }
    getLog().error({ err: error }, logEvent);
    return apiError(c, 500, message);
  }

  // PATCH /api/config/assistants - Update assistant configuration
  registerOpenApiRoute(patchAssistantConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateAssistantConfigBodySchema);

      const updates: Partial<GlobalConfig> = {};
      if (body.assistant !== undefined) {
        if (!isRegisteredProvider(body.assistant)) {
          return apiError(c, 400, missingProviderMessage(providerRegistry, body.assistant));
        }
        updates.defaultAssistant = body.assistant;
      }
      if (body.assistants !== undefined) {
        const unknownProviders = Object.keys(body.assistants).filter(
          id => !isRegisteredProvider(id)
        );
        if (unknownProviders.length > 0) {
          return apiError(
            c,
            400,
            unknownProviders.map(id => missingProviderMessage(providerRegistry, id)).join('; ')
          );
        }
        updates.assistants = body.assistants;
      }

      await updateGlobalConfig(updates);

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      return configUpdateFailed(
        c,
        error,
        'config.assistants_update_failed',
        'Failed to update assistant configuration'
      );
    }
  });

  // PATCH /api/config/tiers - Update model-tier presets (ungated — solo-OK, like /assistants)
  registerOpenApiRoute(patchTiersConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateTiersBodySchema);

      // Validate the provider of each tier we're SETTING (null = unset, skip).
      const tiers: TiersPatch = {};
      for (const tier of TIER_NAMES) {
        const entry = body.tiers[tier];
        if (entry === undefined) continue;
        if (entry === null) {
          tiers[tier] = null;
          continue;
        }
        const errMsg = validatePresetEntry(`tier '${tier}'`, entry);
        if (errMsg) return apiError(c, 400, errMsg);
        tiers[tier] = toCleanEntry(entry);
      }

      await updateGlobalConfig({ tiers });

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      return configUpdateFailed(
        c,
        error,
        'config.tiers_update_failed',
        'Failed to update tier configuration'
      );
    }
  });

  // PATCH /api/config/aliases - Update @custom aliases (ungated — solo-OK, like /tiers)
  registerOpenApiRoute(patchAliasesConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateAliasesBodySchema);
      const aliases: AliasesPatch = {};
      for (const [name, entry] of Object.entries(body.aliases)) {
        const nameErr = validateAliasName(name);
        if (nameErr) return apiError(c, 400, nameErr);
        if (entry === null) {
          aliases[name] = null;
          continue;
        }
        const errMsg = validatePresetEntry(`alias '${name}'`, entry);
        if (errMsg) return apiError(c, 400, errMsg);
        aliases[name] = toCleanEntry(entry);
      }

      await updateGlobalConfig({ aliases });

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      return configUpdateFailed(
        c,
        error,
        'config.aliases_update_failed',
        'Failed to update alias configuration'
      );
    }
  });

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
