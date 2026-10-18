import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ConversationLockManager, SchemaVersionInfo } from '@archon/core';
import { getSchemaVersion } from '@archon/core';
import {
  isDocker,
  isWSL,
  getWSLDistroName,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
} from '@archon/paths';
import * as workflowDb from '@archon/core/db/workflows';
import { PUSH_DESTINATION_STATES, type AttentionRouter } from '../services/attention-router';
import { getLog, openApiRouteRegistrar } from './api-route-kit';
import { updateCheckResponseSchema } from './schemas/system.schemas';

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

export function registerHealthRoutes(
  app: OpenAPIHono,
  {
    lockManager,
    activePlatforms,
    attention,
  }: {
    lockManager: Pick<ConversationLockManager, 'getStats'>;
    activePlatforms?: readonly string[];
    attention?: { router: Pick<AttentionRouter, 'health'> };
  }
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

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
