import {
  splitAttentionRead,
  scopeAttentionDegraded,
} from '@archon/workflows/schemas/attention-degraded';
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
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
import type { AttentionStreamLine } from '@archon/workflows/attention-watch';
import type { IWorkflowEngine } from '@archon/workflows/engine-port';
import { WorkflowEventCursorError, workflowEventCursor } from '@archon/workflows/store';
import { checkedSSEWriter } from '../adapters/web/sse-writer';
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
  attentionStreamLineResponseSchema,
  attentionStreamQuerySchema,
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

const getAttentionStreamRoute = createRoute({
  method: 'get',
  path: '/api/runs/attention/stream',
  tags: ['Workflows'],
  summary: 'Stream the attention queue as server-sent events',
  request: {
    query: attentionStreamQuerySchema,
    headers: z.object({ 'last-event-id': z.string().min(1).optional() }),
  },
  responses: {
    200: {
      content: { 'text/event-stream': { schema: attentionStreamLineResponseSchema } },
      description:
        'One event per attention stream line: data is the line as JSON, id is a cursor Last-Event-ID resumes from',
    },
    400: jsonError('Bad request'),
  },
});

/** The list and stream routes' query as a scope and request; throws a refusal. */
async function attentionHttpRequest(query: z.infer<typeof attentionQueueQuerySchema>): Promise<{
  scope: AttentionQueueScope;
  request: ReturnType<typeof parseAttentionQueueRequest>;
}> {
  const label = query.label ?? [];
  const request = parseAttentionQueueRequest({
    ...query,
    all: query.all === 'true',
    labels: typeof label === 'string' ? [label] : label,
  });
  const scope: AttentionQueueScope =
    query.project === undefined
      ? { kind: 'all' }
      : { kind: 'project', project: await resolveAttentionProject(codebaseDb, query.project) };
  return { scope, request };
}

/**
 * The SSE `id` for each stream line, in order. An id is the cursor of the last event
 * whose lines were all sent, never the current line's: one feed event can produce
 * several lines at one cursor (`resolved` then `terminal`), and resuming after that
 * cursor skips them all, so a client that dropped between them would lose the rest.
 * Undefined means no `id` field, so the client keeps the id it last received.
 */
export function attentionSseIds(): (line: AttentionStreamLine) => string | undefined {
  let committed: string | undefined;
  let pending: string | undefined;
  return line => {
    if (line.type === 'error') return undefined;
    // Stamped with the position before the delivery in progress, so they say nothing
    // about which events are complete. A reconnect re-arms what they report.
    if (line.type === 'owner_lost' || line.type === 'degraded') return committed;
    // `ready` and `bookmark` follow every line at or before their cursor.
    if (line.type === 'ready' || line.type === 'bookmark') {
      committed = line.cursor;
      pending = undefined;
      return committed;
    }
    if (pending !== undefined && pending !== line.cursor) committed = pending;
    pending = line.cursor;
    return committed;
  };
}

/**
 * GET /api/runs/attention/stream - The attention queue over SSE: the open set, `ready`,
 * then every change, each line as `--watch --json` writes it. `watchAttention` is the
 * engine watcher `--watch` uses. Read-only, so like the list route it needs only the
 * `/api/*` access gate.
 */
export function registerAttentionStreamRoute(
  app: OpenAPIHono,
  watchAttention: IWorkflowEngine['watchAttention']
): void {
  openApiRouteRegistrar(app)(getAttentionStreamRoute, async c => {
    let parsed: Awaited<ReturnType<typeof attentionHttpRequest>>;
    try {
      parsed = await attentionHttpRequest(getValidatedQuery(c, attentionStreamQuerySchema));
    } catch (refusal) {
      return apiError(c, 400, (refusal as Error).message);
    }
    const { scope, request } = parsed;
    const lastEventId = c.req.header('last-event-id');
    const after = lastEventId === undefined ? undefined : workflowEventCursor(lastEventId);

    return streamSSE(c, async stream => {
      const writer = checkedSSEWriter(stream);
      const idOf = attentionSseIds();
      let end!: () => void;
      const ended = new Promise<void>(resolve => {
        end = resolve;
      });
      stream.onAbort(end);
      const listener = async (line: AttentionStreamLine): Promise<void> => {
        const id = idOf(line);
        try {
          await writer.writeSSE({
            data: JSON.stringify(line),
            ...(id === undefined ? {} : { id }),
          });
        } catch (error) {
          end();
          throw error;
        }
        if (line.type === 'error') end();
      };

      let watch: Awaited<ReturnType<typeof watchAttention>>;
      try {
        watch = await watchAttention(listener, {
          scope,
          labels: request.labels,
          ...(after === undefined ? {} : { after }),
        });
      } catch (error) {
        if (error instanceof WorkflowEventCursorError) {
          // A failed write means the client already left.
          await listener({ type: 'error', error: 'cursor_invalid' }).catch(() => undefined);
          return;
        }
        // A client gone during the snapshot rejects startup; nothing is left to tell.
        if (!writer.closed) getLog().error({ err: error }, 'api.attention_stream_start_failed');
        return;
      }
      try {
        await ended;
      } finally {
        await watch.close();
      }
    });
  });
}

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
      let parsed: Awaited<ReturnType<typeof attentionHttpRequest>>;
      try {
        parsed = await attentionHttpRequest(getValidatedQuery(c, attentionQueueQuerySchema));
      } catch (refusal) {
        return apiError(c, 400, (refusal as Error).message);
      }
      const { scope, request } = parsed;
      // One read backs both the items and the console's dashboard rows for the same runs.
      const rows = await workflowDb.listAttentionQueueRows();
      const { values: items, degraded } = splitAttentionRead(
        await attentionQueueItems(attentionQueue, rows)
      );
      const reports = scopeAttentionDegraded(degraded, scope);
      const { labels, order, countBy } = request;
      if (countBy !== undefined)
        return c.json({
          counts: countAttentionQueue(items, { scope, labels, countBy }),
          ...reports,
        });
      const selected = selectAttentionQueue(items, { scope, labels, order });
      const ids = new Set(selected.map(item => item.runId));
      const runs = splitAttentionRead(rows).values.filter(run => ids.has(run.id));
      // The queue lists only paused runs, and only a running run has an owner to observe.
      return c.json({
        runs: runs.map(run => toApiDashboardWorkflowRun(run, null)),
        items: selected,
        ...reports,
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
