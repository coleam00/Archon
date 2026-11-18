/**
 * GET /api/items: read one item, its runs, open questions, and answers with rulings
 * (`readItem`). GET /api/items/window: a page of the project's items with a run started in
 * a window (`readItemWindow`). POST /api/items/rulings records a ruling on an item; POST
 * /api/items/rulings/{rulingId}/withdraw withdraws one.
 */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import * as codebaseDb from '@archon/core/db/codebases';
import * as userDb from '@archon/core/db/users';
import {
  attentionQueueSource,
  resolveAttentionProject,
} from '@archon/core/operations/attention-queue';
import {
  assertMayRule,
  ItemRulingForbiddenError,
  recordItemRuling,
  withdrawItemRuling,
} from '@archon/core/operations/item-rulings';
import type { RunActor } from '@archon/core/operations/run-authorization';
import { createWorkflowHostStore } from '@archon/core/workflows/sql-host';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
import { readItem } from '@archon/workflows/item-read';
import { ItemWindowQueryError, readItemWindow } from '@archon/workflows/item-window';
import {
  ItemRulingNotFoundError,
  ItemRulingOutsideProjectError,
  ItemRulingWithdrawnError,
} from '@archon/workflows/schemas/item-ruling';
import type { Context } from 'hono';
import { resolveRunActor } from './api-request-auth';
import {
  apiError,
  getLog,
  getValidatedBody,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import {
  itemReadQuerySchema,
  itemReadResponseSchema,
  itemWindowQuerySchema,
  itemWindowResponseSchema,
  itemRulingResponseSchema,
  recordItemRulingBodySchema,
  withdrawItemRulingBodySchema,
} from './schemas/workflow.schemas';

const getItemRoute = createRoute({
  method: 'get',
  path: '/api/items',
  tags: ['Workflows'],
  summary: 'Read an item: its runs, open questions and answers, oldest first',
  request: { query: itemReadQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: itemReadResponseSchema } },
      description: 'The item',
    },
    400: jsonError('Bad request'),
    404: jsonError('No item under that key in the project'),
    500: jsonError('Server error'),
  },
});

const getItemWindowRoute = createRoute({
  method: 'get',
  path: '/api/items/window',
  tags: ['Workflows'],
  summary: "A page of a project's items with a run started in a window, each read whole",
  request: { query: itemWindowQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: itemWindowResponseSchema } },
      description: 'The page, with the cursor of the next one',
    },
    400: jsonError('Bad request, an unknown project, or a window or cursor that does not resolve'),
    500: jsonError('Server error'),
  },
});

const recordRulingRoute = createRoute({
  method: 'post',
  path: '/api/items/rulings',
  tags: ['Workflows'],
  summary: 'Record a ruling on an item: a decision made without a question being asked',
  request: {
    body: { content: { 'application/json': { schema: recordItemRulingBodySchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: itemRulingResponseSchema } },
      description: 'The ruling as recorded',
    },
    400: jsonError('Bad request'),
    403: jsonError('Only the operator or an admin may record a ruling'),
    500: jsonError('Server error'),
  },
});

const withdrawRulingRoute = createRoute({
  method: 'post',
  path: '/api/items/rulings/{rulingId}/withdraw',
  tags: ['Workflows'],
  summary: 'Withdraw a ruling; the record stays and says it was withdrawn',
  request: {
    params: z.object({ rulingId: z.string() }),
    body: { content: { 'application/json': { schema: withdrawItemRulingBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: itemRulingResponseSchema } },
      description: 'The ruling, now withdrawn',
    },
    400: jsonError('Bad request, an unknown project, or a ruling outside the named project'),
    403: jsonError('Only the operator or an admin may withdraw a ruling'),
    404: jsonError('No ruling with that id'),
    409: jsonError('The ruling was already withdrawn'),
    500: jsonError('Server error'),
  },
});

/**
 * Who records or withdraws, checked against the ruling rule. `as` names only the
 * operator; a request that carries a user keeps the user, as an answer does.
 */
async function rulingActor(c: Context, as: string | undefined): Promise<RunActor> {
  const requester = await resolveRunActor(c);
  const role =
    requester.kind === 'user' ? (await userDb.getUserById(requester.userId))?.role : undefined;
  assertMayRule(requester, role);
  return requester.kind === 'operator' && as !== undefined
    ? { ...requester, declared: as }
    : requester;
}

/**
 * The key of the project a request names, or the resolver's refusal (no such project, an
 * ambiguous name), which is the caller's 400. Reading the codebases can still throw, a 500.
 */
async function projectKeyOf(spec: string): Promise<{ key: string } | { refusal: string }> {
  const codebases = await codebaseDb.listCodebases();
  try {
    return {
      key: (await resolveAttentionProject({ listCodebases: async () => codebases }, spec)).key,
    };
  } catch (refusal) {
    return { refusal: (refusal as Error).message };
  }
}

export function registerItemRoutes(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);
  const source = attentionQueueSource(createWorkflowStore(), createWorkflowHostStore().isolation);

  registerOpenApiRoute(getItemRoute, async c => {
    const query = getValidatedQuery(c, itemReadQuerySchema);
    try {
      const project = await projectKeyOf(query.project);
      if ('refusal' in project) return apiError(c, 400, project.refusal);
      const projectKey = project.key;
      const read = await readItem(source, projectKey, query.key);
      if (read === null) return apiError(c, 404, `No item '${query.key}' in project ${projectKey}`);
      return c.json(read);
    } catch (error) {
      getLog().error({ err: error }, 'api.item_read_failed');
      return apiError(c, 500, 'Failed to read the item');
    }
  });

  registerOpenApiRoute(getItemWindowRoute, async c => {
    const { project: spec, ...query } = getValidatedQuery(c, itemWindowQuerySchema);
    try {
      const project = await projectKeyOf(spec);
      if ('refusal' in project) return apiError(c, 400, project.refusal);
      return c.json(await readItemWindow(source, project.key, query));
    } catch (error) {
      if (error instanceof ItemWindowQueryError) return apiError(c, 400, error.message);
      getLog().error({ err: error }, 'api.item_window_read_failed');
      return apiError(c, 500, 'Failed to read the items');
    }
  });

  registerOpenApiRoute(recordRulingRoute, async c => {
    const body = getValidatedBody(c, recordItemRulingBodySchema);
    try {
      const actor = await rulingActor(c, body.as);
      const project = await projectKeyOf(body.project);
      if ('refusal' in project) return apiError(c, 400, project.refusal);
      const ruling = await recordItemRuling(
        source.store,
        { projectKey: project.key, key: body.key, text: body.text },
        actor,
        'api'
      );
      return c.json(ruling, 201);
    } catch (error) {
      if (error instanceof ItemRulingForbiddenError) return apiError(c, 403, error.message);
      // No log line repeats the ruling's text.
      getLog().error({ err: error }, 'api.item_ruling_record_failed');
      return apiError(c, 500, 'Failed to record the ruling');
    }
  });

  registerOpenApiRoute(withdrawRulingRoute, async c => {
    const rulingId = c.req.param('rulingId') ?? '';
    const body = getValidatedBody(c, withdrawItemRulingBodySchema);
    try {
      const actor = await rulingActor(c, body.as);
      let projectKey: string | undefined;
      if (body.project !== undefined) {
        const project = await projectKeyOf(body.project);
        if ('refusal' in project) return apiError(c, 400, project.refusal);
        projectKey = project.key;
      }
      const target = projectKey === undefined ? { rulingId } : { rulingId, projectKey };
      return c.json(await withdrawItemRuling(source.store, target, actor, 'api'), 200);
    } catch (error) {
      if (error instanceof ItemRulingOutsideProjectError) return apiError(c, 400, error.message);
      if (error instanceof ItemRulingForbiddenError) return apiError(c, 403, error.message);
      if (error instanceof ItemRulingNotFoundError) return apiError(c, 404, error.message);
      if (error instanceof ItemRulingWithdrawnError) return apiError(c, 409, error.message);
      getLog().error({ err: error, rulingId }, 'api.item_ruling_withdraw_failed');
      return apiError(c, 500, 'Failed to withdraw the ruling');
    }
  });
}
