/**
 * Linear-tracker REST proxy routes. Mounted only when the server boots a
 * Symphony service that has a Linear tracker configured. Routes are namespaced
 * under `/api/linear/*`.
 *
 * Phase 3 of the Mission Control rollout — exposes a read-through to Linear's
 * full backlog and a write-through `issueUpdate` so the Symphony tab kanban
 * can drag cards between state lanes and have those changes flow back to
 * Linear.
 *
 * Phase 3 deliberately does not introduce a `linear_issues_cache` table —
 * Mission Control reads on-demand. A subsequent phase can layer caching on
 * top if the Linear API call latency proves too painful.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { SymphonyServiceHandle } from '@archon/symphony';
import { LinearTracker } from '@archon/symphony/tracker/linear';
import { createLogger } from '@archon/paths';
import { errorSchema } from './schemas/common.schemas';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('api.linear');
  return cachedLog;
}

function jsonError(description: string): {
  content: { 'application/json': { schema: typeof errorSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorSchema } }, description };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const linearIssueSchema = z
  .object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    priority: z.number().nullable(),
    url: z.string().nullable(),
    state: z.object({ id: z.string(), name: z.string(), type: z.string() }).nullable(),
    updatedAt: z.string().nullable(),
  })
  .openapi('LinearIssue');

const linearIssueListResponseSchema = z
  .object({ issues: z.array(linearIssueSchema) })
  .openapi('LinearIssueListResponse');

const linearIssueUpdateAckSchema = z.object({ ok: z.boolean() }).openapi('LinearIssueUpdateAck');

const linearIssueUpdateBodySchema = z
  .object({
    stateId: z.string().min(1).optional(),
    sortOrder: z.number().optional(),
  })
  .refine(b => b.stateId !== undefined || b.sortOrder !== undefined, {
    message: 'At least one of stateId or sortOrder must be provided',
  })
  .openapi('LinearIssueUpdateBody');

// ---------------------------------------------------------------------------
// Route configs
// ---------------------------------------------------------------------------

const listLinearIssuesRoute = createRoute({
  method: 'get',
  path: '/api/linear/issues',
  tags: ['Linear'],
  summary: 'Fetch full Linear backlog (project-scoped, no state filter)',
  responses: {
    200: {
      content: { 'application/json': { schema: linearIssueListResponseSchema } },
      description: 'OK',
    },
    503: jsonError('Linear tracker not configured'),
    500: jsonError('Server error'),
  },
});

const updateLinearIssueRoute = createRoute({
  method: 'patch',
  path: '/api/linear/issues/{id}',
  tags: ['Linear'],
  summary: 'Mutate a Linear issue (stateId, sortOrder)',
  request: {
    body: {
      content: { 'application/json': { schema: linearIssueUpdateBodySchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: linearIssueUpdateAckSchema } },
      description: 'Update accepted',
    },
    400: jsonError('Invalid body'),
    503: jsonError('Linear tracker not configured'),
    500: jsonError('Server error'),
  },
});

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function registerLinearRoutes(app: OpenAPIHono, handle: SymphonyServiceHandle): void {
  function jsonRes(c: Context, status: 400 | 404 | 500 | 503, message: string): Response {
    return c.json({ error: message }, status);
  }

  function registerOpenApiRoute(
    route: ReturnType<typeof createRoute>,
    handler: (c: Context) => Response | Promise<Response>
  ): void {
    app.openapi(route, handler as never);
  }

  function getLinear(): LinearTracker | null {
    const t = handle.trackers.linear;
    if (!t) return null;
    if (!(t instanceof LinearTracker)) return null;
    return t;
  }

  registerOpenApiRoute(listLinearIssuesRoute, async c => {
    const linear = getLinear();
    if (!linear) return jsonRes(c, 503, 'Linear tracker not configured');
    try {
      const issues = await linear.fetchAllIssues();
      return c.json({ issues }, 200);
    } catch (err) {
      getLog().error({ err }, 'linear.list_issues_failed');
      return jsonRes(c, 500, 'Failed to list Linear issues');
    }
  });

  registerOpenApiRoute(updateLinearIssueRoute, async c => {
    const linear = getLinear();
    if (!linear) return jsonRes(c, 503, 'Linear tracker not configured');
    const id = c.req.param('id') ?? '';
    if (!id) return jsonRes(c, 400, 'issue id required in path');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonRes(c, 400, 'invalid JSON body');
    }
    const parsed = linearIssueUpdateBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonRes(c, 400, parsed.error.issues.map(i => i.message).join('; '));
    }
    try {
      await linear.updateIssue(id, parsed.data);
      return c.json({ ok: true }, 200);
    } catch (err) {
      getLog().error({ err, id }, 'linear.update_issue_failed');
      return jsonRes(c, 500, 'Failed to update Linear issue');
    }
  });
}
