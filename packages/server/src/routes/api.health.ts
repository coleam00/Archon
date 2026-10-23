import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { ConversationLockManager, SchemaVersionInfo } from '@archon/core';
import { getSchemaVersion } from '@archon/core';
import {
  isDocker,
  isWSL,
  getWSLDistroName,
  checkForUpdate,
  BUNDLED_IS_BINARY,
} from '@archon/paths';
import { readStoreId } from '@archon/paths/server-discovery';
import * as workflowDb from '@archon/core/db/workflows';
import { PUSH_DESTINATION_STATES, type AttentionRouter } from '../services/attention-router';
import { appVersion } from '../app-version';
import { getLog, openApiRouteRegistrar } from './api-route-kit';
import { updateCheckResponseSchema } from './schemas/system.schemas';

/**
 * Public aggregate view of conversation processing. Health is outside the auth
 * gate, so it carries counts and ages but never a conversation id; the
 * per-conversation facts are on the gated `GET /api/dashboard/conversations`.
 */
const healthConcurrencySchema = z.object({
  active: z
    .number()
    .describe('Conversations holding a processing slot plus background workflow conversations'),
  queuedTotal: z.number(),
  maxConcurrent: z.number(),
  oldestActiveAgeMs: z
    .number()
    .nullable()
    .describe(
      'Age of the oldest conversation holding a processing slot in this process. Background workflow runs are counted in `active` but not aged here; see /api/dashboard/runs.'
    ),
  oldestQueuedAgeMs: z.number().nullable().describe('Age of the oldest waiting message'),
});

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
              storeId: z
                .string()
                .optional()
                .describe(
                  "Opaque id of the Archon home this server serves. Compare it with that home's `store-id` file to confirm the server serves the home you mean. Omitted when the home has no readable store id."
                ),
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

function oldestAge(ages: number[]): number | null {
  return ages.length === 0 ? null : Math.max(...ages);
}

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

    // Background workflows bypass the lock manager, so `active` counts the union
    // of both sources. The ids only feed the count and never reach the response.
    const activeIds = new Set(stats.activeConversations.map(c => c.conversationId));
    for (const row of runningWorkflowRows) {
      if (row.conversation_id !== null) activeIds.add(row.conversation_id);
    }
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

    let storeId: string | null = null;
    try {
      storeId = readStoreId();
    } catch (err) {
      getLog().warn({ err }, 'api.store_id_read_failed');
    }

    const concurrency: z.infer<typeof healthConcurrencySchema> = {
      active: activeIds.size,
      queuedTotal: stats.queuedTotal,
      maxConcurrent: stats.maxConcurrent,
      oldestActiveAgeMs: oldestAge(stats.activeConversations.map(c => c.ageMs)),
      oldestQueuedAgeMs: oldestAge(stats.queuedConversations.map(c => c.oldestAgeMs)),
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
      ...(storeId ? { storeId } : {}),
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
