import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import * as codebaseDb from '@archon/core/db/codebases';
import * as workflowDb from '@archon/core/db/workflows';
import {
  attentionQueueSource,
  resolveAttentionProject,
} from '@archon/core/operations/attention-queue';
import { RunActionForbiddenError } from '@archon/core/operations/run-authorization';
import {
  StaleGateAnswerError,
  assertLabelable,
  type WorkflowOperations,
} from '@archon/core/operations/workflow-operations';
import { createWorkflowHostStore } from '@archon/core/workflows/sql-host';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
import {
  attentionQueueItems,
  countAttentionQueue,
  parseAttentionQueueRequest,
  readAttentionQueueItem,
  selectAttentionQueue,
  type AttentionQueueScope,
} from '@archon/workflows/attention-queue';
import { resolveRunActor } from './api-request-auth';
import {
  apiError,
  getLog,
  getValidatedBody,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { toApiDashboardWorkflowRun } from './api-serializers';
import {
  attentionQueueCountsResponseSchema,
  attentionQueueItemResponseSchema,
  attentionQueueQuerySchema,
  labelAttentionBodySchema,
  labelAttentionResponseSchema,
  runsNeedingAttentionResponseSchema,
} from './schemas/workflow.schemas';

const getRunsNeedingAttentionRoute = createRoute({
  method: 'get',
  path: '/api/runs/attention',
  tags: ['Workflows'],
  summary: 'List or count the attention queue',
  request: { query: attentionQueueQuerySchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.union([runsNeedingAttentionResponseSchema, attentionQueueCountsResponseSchema]),
        },
      },
      description: 'The items in scope, or their counts when countBy is given',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getRunAttentionItemRoute = createRoute({
  method: 'get',
  path: '/api/runs/{runId}/attention',
  tags: ['Workflows'],
  summary: 'Read the attention queue item a run stands for',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: attentionQueueItemResponseSchema } },
      description: 'The item, or null when the run needs no one now',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const labelRunAttentionRoute = createRoute({
  method: 'post',
  path: '/api/runs/{runId}/attention/labels',
  tags: ['Workflows'],
  summary: 'Set or remove labels on the attention wait a run is paused at',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: labelAttentionBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: labelAttentionResponseSchema } },
      description: 'Labeled',
    },
    400: jsonError('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    409: jsonError('The write names an occurrence the run is no longer paused at'),
    500: jsonError('Server error'),
  },
});

export function registerRunAttentionRoutes(
  app: OpenAPIHono,
  operations: Pick<WorkflowOperations, 'assertRunActionAllowed' | 'labelAttentionWait'>
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);
  const { assertRunActionAllowed, labelAttentionWait } = operations;
  const attentionQueue = attentionQueueSource(
    createWorkflowStore(),
    createWorkflowHostStore().isolation
  );

  // GET /api/runs/attention - The attention queue. A server has no working directory, so
  // without `project` the scope is the whole install.
  registerOpenApiRoute(getRunsNeedingAttentionRoute, async c => {
    try {
      const query = getValidatedQuery(c, attentionQueueQuerySchema);
      const label = query.label ?? [];
      let scope: AttentionQueueScope;
      let request: ReturnType<typeof parseAttentionQueueRequest>;
      try {
        request = parseAttentionQueueRequest({
          ...query,
          all: query.all === 'true',
          labels: typeof label === 'string' ? [label] : label,
        });
        scope =
          query.project === undefined
            ? { kind: 'all' }
            : {
                kind: 'project',
                project: await resolveAttentionProject(codebaseDb, query.project),
              };
      } catch (refusal) {
        return apiError(c, 400, (refusal as Error).message);
      }
      // One read backs both the items and the console's dashboard rows for the same runs.
      const rows = await workflowDb.listAttentionQueueRows();
      const items = await attentionQueueItems(attentionQueue, rows);
      const { labels, order, countBy } = request;
      if (countBy !== undefined)
        return c.json({ counts: countAttentionQueue(items, { scope, labels, countBy }) });
      const selected = selectAttentionQueue(items, { scope, labels, order });
      const ids = new Set(selected.map(item => item.runId));
      const runs = rows.filter(run => ids.has(run.id));
      // The queue lists only paused runs, and only a running run has an owner to observe.
      return c.json({
        runs: runs.map(run => toApiDashboardWorkflowRun(run, null)),
        items: selected,
      });
    } catch (error) {
      getLog().error({ err: error }, 'list_runs_needing_attention_failed');
      return apiError(c, 500, 'Failed to list runs needing attention');
    }
  });

  // GET /api/runs/:runId/attention - The item a run stands for; a parent blocked on
  // sub-runs resolves to its child's item.
  registerOpenApiRoute(getRunAttentionItemRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const item = await readAttentionQueueItem(attentionQueue, runId);
      if (item === undefined) return apiError(c, 404, 'Workflow run not found');
      return c.json({ item });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.run_attention_item_failed');
      return apiError(c, 500, 'Failed to read the attention queue item');
    }
  });

  // POST /api/runs/:runId/attention/labels - Merge a label write into the open attention wait.
  registerOpenApiRoute(labelRunAttentionRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) return apiError(c, 404, 'Workflow run not found');
      const actor = await resolveRunActor(c);
      await assertRunActionAllowed(run, actor, 'respond');
      const body = getValidatedBody(c, labelAttentionBodySchema);
      const request = { occurrence: body.occurrence, set: body.set ?? {}, unset: body.unset ?? [] };
      try {
        assertLabelable(run, request, 'api');
      } catch (refusal) {
        if (refusal instanceof StaleGateAnswerError) return apiError(c, 409, refusal.message);
        return apiError(c, 400, (refusal as Error).message);
      }
      return c.json(await labelAttentionWait(runId, request, actor, 'api'));
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      // A race lost after the pre-check above: the run moved to another pause meanwhile.
      if (error instanceof StaleGateAnswerError) return apiError(c, 409, error.message);
      getLog().error({ err: error, runId }, 'api.run_attention_label_failed');
      return apiError(c, 500, 'Failed to label the attention wait');
    }
  });
}
