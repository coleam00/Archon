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
  answerAttentionItem,
  answerPermission,
  settledWithNothingStarted,
  withdrawAttentionItem,
  type AttentionItemAnswerResult,
} from '@archon/core/operations/attention-items';
import {
  AttentionAnswerInvalidError,
  StaleGateAnswerError,
  assertLabelable,
  type WorkflowOperations,
} from '@archon/core/operations/workflow-operations';
import { createWorkflowHostStore } from '@archon/core/workflows/sql-host';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
import { countAttentionQueue } from '@archon/workflows/attention-counts';
import {
  listAttentionQueue,
  parseAttentionQueueRequest,
  readAttentionQueueItem,
  selectAttentionQueue,
  type AttentionQueueScope,
  heldRunOf,
} from '@archon/workflows/attention-queue';
import { attentionWatchReader } from '@archon/workflows/attention-needs';
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
  answerAttentionItemBodySchema,
  attentionItemActionResponseSchema,
  attentionQueueCountsResponseSchema,
  withdrawAttentionItemBodySchema,
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

const answerAttentionItemRoute = createRoute({
  method: 'post',
  path: '/api/attention/answer',
  tags: ['Workflows'],
  summary: 'Answer an attention queue item by its ref',
  request: {
    body: { content: { 'application/json': { schema: answerAttentionItemBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: attentionItemActionResponseSchema } },
      description: 'Answered, or the item already had this answer',
    },
    400: jsonError('Bad request: the answer does not fit the item'),
    404: jsonError('Nothing the caller may answer has this ref'),
    409: jsonError('The item is closed, moved, takes no answer, or was answered differently'),
    500: jsonError('Server error'),
  },
});

const withdrawAttentionItemRoute = createRoute({
  method: 'post',
  path: '/api/attention/withdraw',
  tags: ['Workflows'],
  summary: 'Withdraw an ask, or the open waits, a completed run left, by its ref',
  request: {
    body: { content: { 'application/json': { schema: withdrawAttentionItemBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: attentionItemActionResponseSchema } },
      description: 'Withdrawn, or already withdrawn',
    },
    400: jsonError('The ref names an item a paused run holds, which is answered, not withdrawn'),
    404: jsonError('Nothing the caller may withdraw has this ref'),
    409: jsonError('The ask was already answered or replaced, or the waits met or replaced'),
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
  // This route counts the items open now, which have no answerer; that count reads
  // started waits from events and is the CLI's `--count-by answerer --since`.
  if (query.countBy === 'answerer')
    throw new Error("countBy must be 'project' or 'label:<key>', got 'answerer'");
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
 * then every change, each line as `--watch --protocol --json` writes it; `level=quiet`
 * sends only the lines `--watch` writes by default, and `level=notices` the lines
 * `--watch --notices` writes. `watchAttention` is the
 * engine watcher `--watch` uses. Read-only, so like the list route it needs only the
 * `/api/*` access gate.
 */
export function registerAttentionStreamRoute(
  app: OpenAPIHono,
  watchAttention: IWorkflowEngine['watchAttention']
): void {
  openApiRouteRegistrar(app)(getAttentionStreamRoute, async c => {
    const query = getValidatedQuery(c, attentionStreamQuerySchema);
    let parsed: Awaited<ReturnType<typeof attentionHttpRequest>>;
    try {
      parsed = await attentionHttpRequest(query);
    } catch (refusal) {
      return apiError(c, 400, (refusal as Error).message);
    }
    const { scope, request } = parsed;
    const level = query.level ?? 'protocol';
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
      const read = attentionWatchReader(level, { resumed: after !== undefined });
      const listener = async (unclassified: AttentionStreamLine): Promise<void> => {
        const line = read(unclassified);
        if (line === undefined) return;
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

type AttentionItemReply =
  | { body: z.infer<typeof attentionItemActionResponseSchema> }
  | { status: 400 | 404 | 409; error: string };

/** `settled`, and `nothingStarted` when the settlement started no binding. */
function settlement(result: Parameters<typeof settledWithNothingStarted>[0]): {
  settled: boolean;
  nothingStarted?: true;
} {
  return settledWithNothingStarted(result)
    ? { settled: true, nothingStarted: true }
    : { settled: result.settled };
}

/** The HTTP reply to an answer by ref. */
function answerReply(ref: string, result: AttentionItemAnswerResult): AttentionItemReply {
  const base = { ref, action: 'answer' as const };
  switch (result.kind) {
    case 'ask_answered':
      return { body: { ...base, unchanged: false, ...settlement(result) } };
    case 'unchanged':
      return { body: { ...base, unchanged: true } };
    case 'answered':
      return {
        body: {
          ...base,
          unchanged: false,
          runId: result.item.run.id,
          continues: result.continues,
          cancelled: result.cancelled,
        },
      };
    case 'unknown':
      return { status: 404, error: `Nothing you may answer has ref '${ref}'` };
    case 'none':
      return { status: 409, error: `Item '${ref}' is no longer open` };
    case 'moved':
      return {
        status: 409,
        error: `Item '${ref}' is over; its run now holds '${result.item.ref}'`,
      };
    case 'takes_no_answer':
      return { status: 409, error: `Item '${ref}' takes no answer` };
    case 'refused':
      return result.reason === 'already_answered'
        ? { status: 409, error: `Item '${ref}' was already answered differently` }
        : { status: 400, error: result.reason };
  }
}

/** The status a refused answer maps to, or undefined for a failure of the server's own. */
function answerRefusal(error: unknown): { status: 400 | 404 | 409; error: string } | undefined {
  if (error instanceof RunActionForbiddenError) return { status: 404, error: error.message };
  if (error instanceof StaleGateAnswerError) return { status: 409, error: error.message };
  if (error instanceof AttentionAnswerInvalidError) return { status: 400, error: error.message };
  return undefined;
}

export function registerRunAttentionRoutes(
  app: OpenAPIHono,
  operations: Pick<
    WorkflowOperations,
    'assertRunActionAllowed' | 'labelAttentionWait' | 'answerWorkflow' | 'respondToWorkflow'
  >
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);
  const { assertRunActionAllowed, labelAttentionWait } = operations;
  const attentionQueue = attentionQueueSource(
    createWorkflowStore(),
    createWorkflowHostStore().isolation
  );
  const answerDeps = { queue: attentionQueue, operations };

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
      // One read backs both the items and the console's dashboard rows for the same runs:
      // the queue builds the items from the rows read here.
      const rows = await workflowDb.listAttentionQueueRows();
      const { values: items, degraded } = splitAttentionRead(
        await listAttentionQueue(attentionQueue, rows)
      );
      const reports = scopeAttentionDegraded(degraded, scope);
      const { labels, order, countBy } = request;
      if (countBy !== undefined)
        return c.json({
          counts: countAttentionQueue(items, { scope, labels, countBy }),
          ...reports,
        });
      const selected = selectAttentionQueue(items, { scope, labels, order });
      const ids = new Set(selected.map(item => heldRunOf(item)?.id));
      const runs = splitAttentionRead(rows).values.filter(run => ids.has(run.id));
      const actor = await resolveRunActor(c);
      const answerRefusals: Record<string, string> = {};
      for (const item of selected) {
        const permission = await answerPermission(answerDeps, item, actor);
        if (permission.kind === 'refused') answerRefusals[item.ref] = permission.reason;
      }
      // A row is a paused run, and only a running run has an owner to observe.
      return c.json({
        runs: runs.map(run => toApiDashboardWorkflowRun(run, null, null)),
        items: selected,
        answerRefusals,
        ...reports,
      });
    } catch (error) {
      getLog().error({ err: error }, 'list_runs_needing_attention_failed');
      return apiError(c, 500, 'Failed to list runs needing attention');
    }
  });

  // POST /api/attention/answer - Answer the item a ref names, through the one answer
  // operation every surface uses. An ask a completed run left has no run to name.
  registerOpenApiRoute(answerAttentionItemRoute, async c => {
    const body = getValidatedBody(c, answerAttentionItemBodySchema);
    try {
      const actor = await resolveRunActor(c);
      const text = body.text === undefined ? {} : { text: body.text };
      const answer =
        body.recommended === true
          ? { recommended: true as const, ...text }
          : { choose: body.choose ?? [], ...text };
      const reply = answerReply(
        body.ref,
        await answerAttentionItem(answerDeps, body.ref, answer, actor, 'api')
      );
      return 'body' in reply ? c.json(reply.body, 200) : apiError(c, reply.status, reply.error);
    } catch (error) {
      const refusal = answerRefusal(error);
      if (refusal !== undefined) return apiError(c, refusal.status, refusal.error);
      getLog().error({ err: error }, 'api.attention_answer_failed');
      return apiError(c, 500, 'Failed to answer the attention item');
    }
  });

  // POST /api/attention/withdraw - Withdraw an ask or the open waits a completed run left.
  registerOpenApiRoute(withdrawAttentionItemRoute, async c => {
    const body = getValidatedBody(c, withdrawAttentionItemBodySchema);
    try {
      const actor = await resolveRunActor(c);
      const result = await withdrawAttentionItem(answerDeps, body.ref, actor, 'api');
      const base = { ref: body.ref, action: 'withdraw' as const };
      switch (result.kind) {
        case 'withdrawn':
          return c.json({ ...base, unchanged: false, ...settlement(result) }, 200);
        case 'unchanged':
          return c.json({ ...base, unchanged: true }, 200);
        case 'unknown':
          return apiError(c, 404, `Nothing you may withdraw has ref '${body.ref}'`);
        case 'not_an_ask':
          return apiError(c, 400, `Item '${body.ref}' is held by a paused run; answer it instead`);
        case 'refused':
          return apiError(c, 409, `Item '${body.ref}' was already ${result.closedAs}`);
      }
    } catch (error) {
      getLog().error({ err: error }, 'api.attention_withdraw_failed');
      return apiError(c, 500, 'Failed to withdraw the attention item');
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
