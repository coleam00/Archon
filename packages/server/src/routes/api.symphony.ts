/**
 * Symphony route registrations. Mounted only when the server boots a Symphony
 * service (i.e. `~/.archon/symphony.yaml` exists). Routes are namespaced under
 * `/api/symphony/*` to keep them out of the existing `/api/workflows` surface.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { SymphonyServiceHandle } from '@archon/symphony';
import { listDispatches, getDispatchById } from '@archon/symphony/db/dispatches';
import { getDatabase } from '@archon/core/db';
import { createLogger } from '@archon/paths';
import {
  symphonyDispatchActionBodySchema,
  symphonyDispatchActionResponseSchema,
  symphonyDispatchListResponseSchema,
  symphonyDispatchRowSchema,
  symphonyListDispatchesQuerySchema,
  symphonyRefreshResponseSchema,
  symphonyStateResponseSchema,
} from './schemas/symphony.schemas';
import { errorSchema } from './schemas/common.schemas';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('api.symphony');
  return cachedLog;
}

function jsonError(description: string): {
  content: { 'application/json': { schema: typeof errorSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorSchema } }, description };
}

// ---------------------------------------------------------------------------
// Route configs
// ---------------------------------------------------------------------------

const getSymphonyStateRoute = createRoute({
  method: 'get',
  path: '/api/symphony/state',
  tags: ['Symphony'],
  summary: 'Symphony orchestrator snapshot (running, retrying, completed)',
  responses: {
    200: {
      content: { 'application/json': { schema: symphonyStateResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const listSymphonyDispatchesRoute = createRoute({
  method: 'get',
  path: '/api/symphony/dispatches',
  tags: ['Symphony'],
  summary: 'List symphony_dispatches rows',
  request: { query: symphonyListDispatchesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: symphonyDispatchListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getSymphonyDispatchRoute = createRoute({
  method: 'get',
  path: '/api/symphony/dispatches/{id}',
  tags: ['Symphony'],
  summary: 'Fetch one symphony_dispatches row by id',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: symphonyDispatchRowSchema } },
      description: 'OK',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const dispatchSymphonyRoute = createRoute({
  method: 'post',
  path: '/api/symphony/dispatch',
  tags: ['Symphony'],
  summary: 'Trigger an immediate dispatch attempt for a known dispatch_key',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: symphonyDispatchActionBodySchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: symphonyDispatchActionResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const cancelSymphonyRoute = createRoute({
  method: 'post',
  path: '/api/symphony/cancel',
  tags: ['Symphony'],
  summary: 'Cancel a running Symphony dispatch and its workflow run',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: symphonyDispatchActionBodySchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: symphonyDispatchActionResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const refreshSymphonyRoute = createRoute({
  method: 'post',
  path: '/api/symphony/refresh',
  tags: ['Symphony'],
  summary: 'Force the Symphony tick loop to run on the next event-loop turn',
  responses: {
    200: {
      content: { 'application/json': { schema: symphonyRefreshResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

// ---------------------------------------------------------------------------
// Public entry: `registerSymphonyRoutes(app, handle)`
// ---------------------------------------------------------------------------

export function registerSymphonyRoutes(app: OpenAPIHono, handle: SymphonyServiceHandle): void {
  function jsonRes(c: Context, status: 400 | 404 | 500, message: string): Response {
    return c.json({ error: message }, status);
  }

  function registerOpenApiRoute(
    route: ReturnType<typeof createRoute>,
    handler: (c: Context) => Response | Promise<Response>
  ): void {
    app.openapi(route, handler as never);
  }

  registerOpenApiRoute(getSymphonyStateRoute, c => {
    try {
      const view = handle.orchestrator.getSnapshotView();
      return c.json(view, 200);
    } catch (err) {
      getLog().error({ err }, 'symphony.state_failed');
      return jsonRes(c, 500, 'Failed to read symphony state');
    }
  });

  registerOpenApiRoute(listSymphonyDispatchesRoute, async c => {
    try {
      const rawStatus = c.req.query('status');
      const allowedStatuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
      type AllowedStatus = (typeof allowedStatuses)[number];
      const status: AllowedStatus | undefined =
        rawStatus && (allowedStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as AllowedStatus)
          : undefined;
      const rawLimit = c.req.query('limit');
      const limit = rawLimit ? Math.max(1, Math.min(parseInt(rawLimit, 10), 500)) : undefined;
      const dispatches = await listDispatches(getDatabase(), { status, limit });
      return c.json({ dispatches }, 200);
    } catch (err) {
      getLog().error({ err }, 'symphony.list_dispatches_failed');
      return jsonRes(c, 500, 'Failed to list symphony dispatches');
    }
  });

  registerOpenApiRoute(getSymphonyDispatchRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const row = await getDispatchById(getDatabase(), id);
      if (!row) return jsonRes(c, 404, 'Dispatch not found');
      return c.json(row, 200);
    } catch (err) {
      getLog().error({ err, id }, 'symphony.get_dispatch_failed');
      return jsonRes(c, 500, 'Failed to get symphony dispatch');
    }
  });

  function readDispatchKey(body: unknown): string | null {
    if (typeof body === 'object' && body !== null) {
      const v = (body as Record<string, unknown>).dispatch_key;
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

  registerOpenApiRoute(dispatchSymphonyRoute, async c => {
    try {
      const dispatchKey = readDispatchKey(await c.req.json());
      if (!dispatchKey) {
        return jsonRes(c, 400, 'dispatch_key required');
      }
      const result = await handle.orchestrator.requestImmediateDispatch(dispatchKey);
      if (result.ok) {
        return c.json({ ok: true, dispatch_key: result.dispatch_key }, 200);
      }
      return c.json({ ok: false, code: result.code, reason: result.reason }, 200);
    } catch (err) {
      getLog().error({ err }, 'symphony.dispatch_failed');
      return jsonRes(c, 500, 'Failed to dispatch');
    }
  });

  registerOpenApiRoute(cancelSymphonyRoute, async c => {
    try {
      const dispatchKey = readDispatchKey(await c.req.json());
      if (!dispatchKey) {
        return jsonRes(c, 400, 'dispatch_key required');
      }
      const result = handle.orchestrator.requestCancel(dispatchKey);
      if (result.ok) {
        return c.json({ ok: true, dispatch_key: result.dispatch_key }, 200);
      }
      return c.json({ ok: false, code: result.code, reason: result.reason }, 200);
    } catch (err) {
      getLog().error({ err }, 'symphony.cancel_failed');
      return jsonRes(c, 500, 'Failed to cancel');
    }
  });

  registerOpenApiRoute(refreshSymphonyRoute, c => {
    try {
      const result = handle.orchestrator.requestRefresh();
      return c.json(result, 200);
    } catch (err) {
      getLog().error({ err }, 'symphony.refresh_failed');
      return jsonRes(c, 500, 'Failed to refresh');
    }
  });
}
