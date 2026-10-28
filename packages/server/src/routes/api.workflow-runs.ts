import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import * as conversationDb from '@archon/core/db/conversations';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import { observeRunOwner } from '@archon/core/services/run-attention-watch';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
import { nodeCostScope } from '@archon/workflows/node-record-serialization';
import { buildRunNodeStates, getTerminalRecord } from '@archon/workflows/terminal-record';
import { resolveAuthContext } from './api-request-auth';
import { apiError, getLog, jsonError, openApiRouteRegistrar } from './api-route-kit';
import { toApiDashboardWorkflowRun, toApiWorkflowRun } from './api-serializers';
import {
  dashboardRunsQuerySchema,
  dashboardRunsResponseSchema,
  providerEventsQuerySchema,
  providerEventsResponseSchema,
  workflowRunByWorkerResponseSchema,
  workflowRunDetailSchema,
  workflowRunListResponseSchema,
  workflowRunStatusSchema,
  workflowRunsQuerySchema,
} from './schemas/workflow.schemas';

const getDashboardRunsRoute = createRoute({
  method: 'get',
  path: '/api/dashboard/runs',
  tags: ['Workflows'],
  summary: 'List enriched workflow runs for the Command Center dashboard',
  request: { query: dashboardRunsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: dashboardRunsResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getWorkflowRunByWorkerRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/by-worker/{platformId}',
  tags: ['Workflows'],
  summary: 'Look up a workflow run by its worker conversation platform ID',
  request: { params: z.object({ platformId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunByWorkerResponseSchema } },
      description: 'Workflow run',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const listWorkflowRunsRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs',
  tags: ['Workflows'],
  summary: 'List workflow runs',
  request: { query: workflowRunsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getWorkflowRunRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/{runId}',
  tags: ['Workflows'],
  summary: 'Get workflow run details with events',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunDetailSchema } },
      description: 'Workflow run detail',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getProviderEventsRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/{runId}/provider-events',
  tags: ['Workflows'],
  summary: "List a run's provider events",
  description:
    "Every event the run's providers streamed (text, thinking, tool calls with output, warnings, MCP status, compaction, subtasks, hooks, state), as the engine recorded them. Grouped by node; each node's in emission order. Rows written before the engine recorded envelopes come back translated, with a null attemptId.",
  request: { params: z.object({ runId: z.string() }), query: providerEventsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: providerEventsResponseSchema } },
      description: 'Provider events',
    },
    400: jsonError('Invalid cursor'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

export function registerDashboardRunsRoute(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/dashboard/runs - Enriched workflow runs for Command Center
  // Supports server-side search, status/date filtering, and offset pagination.
  registerOpenApiRoute(getDashboardRunsRoute, async c => {
    try {
      const rawStatus = c.req.query('status');
      const validStatuses = workflowRunStatusSchema.options;
      type DashboardRunStatus = (typeof validStatuses)[number];
      const status: DashboardRunStatus | undefined =
        rawStatus && (validStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as DashboardRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const search = c.req.query('search')?.trim() || undefined;
      const after = c.req.query('after') ?? undefined;
      const before = c.req.query('before') ?? undefined;
      const limitRaw = Number(c.req.query('limit'));
      const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(1, limitRaw), 200);
      const offsetRaw = Number(c.req.query('offset'));
      const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);

      const result = await workflowDb.listDashboardRuns({
        status,
        codebaseId,
        search,
        after,
        before,
        limit,
        offset,
      });
      const store = createWorkflowStore();
      return c.json({
        ...result,
        runs: await Promise.all(
          result.runs.map(async run =>
            toApiDashboardWorkflowRun(run, await observeRunOwner(store, run))
          )
        ),
      });
    } catch (error) {
      getLog().error({ err: error }, 'list_dashboard_runs_failed');
      return apiError(c, 500, 'Failed to list dashboard runs');
    }
  });
}

export function registerWorkflowRunReadRoutes(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/workflows/runs - List workflow runs
  registerOpenApiRoute(listWorkflowRunsRoute, async c => {
    try {
      const conversationId = c.req.query('conversationId') ?? undefined;
      const rawStatus = c.req.query('status');
      const validStatuses = workflowRunStatusSchema.options;
      type WorkflowRunStatus = (typeof validStatuses)[number];
      const status: WorkflowRunStatus | undefined =
        rawStatus && (validStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as WorkflowRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const limitRaw = Number(c.req.query('limit'));
      const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(1, limitRaw), 200);
      // Non-enforcing "mine" filter: only narrows when an identity resolves.
      // Default visibility stays open (everyone sees everyone's runs).
      const mine = c.req.query('mine') === 'true';
      const userId = mine ? (await resolveAuthContext(c))?.userId : undefined;

      // Open-work inbox (#2747): a status-derived query, not a stored flag —
      // terminal failed runs with no adopter/successor. Mutually exclusive with
      // the other filters by contract; the inbox wins when combined.
      if (c.req.query('open') === 'true') {
        const openRuns = await workflowDb.findOpenWorkRuns({ codebaseId, limit });
        return c.json({ runs: openRuns.map(toApiWorkflowRun) });
      }

      const runs = await workflowDb.listWorkflowRuns({
        conversationId,
        status,
        limit,
        codebaseId,
        userId,
      });
      return c.json({ runs: runs.map(toApiWorkflowRun) });
    } catch (error) {
      getLog().error({ err: error }, 'list_workflow_runs_failed');
      return apiError(c, 500, 'Failed to list workflow runs');
    }
  });

  // GET /api/workflows/runs/by-worker/:platformId - Look up run by worker conversation
  // Must be registered before :runId to avoid "by-worker" matching as a runId
  registerOpenApiRoute(getWorkflowRunByWorkerRoute, async c => {
    try {
      const platformId = c.req.param('platformId') ?? '';
      const run = await workflowDb.getWorkflowRunByWorkerPlatformId(platformId);
      if (!run) {
        return apiError(c, 404, 'No workflow run found for this worker');
      }
      return c.json({ run: toApiWorkflowRun(run) });
    } catch (error) {
      getLog().error({ err: error }, 'workflow_run_by_worker_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }
  });

  // GET /api/workflows/runs/:runId - Get run details with events
  registerOpenApiRoute(getWorkflowRunRoute, async c => {
    try {
      const runId = c.req.param('runId') ?? '';
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      // Provider events are served by their own route, per node; a long run has
      // thousands and they would dominate this payload.
      const events = await workflowEventDb.listWorkflowEvents(runId, {
        excludeEventTypes: workflowEventDb.PROVIDER_EVENT_ROW_TYPES,
      });

      // Look up the run's conversation platform ID.
      // For web runs (parent_conversation_id set): conversation_id is the worker conversation → set worker_platform_id
      // For CLI runs (no parent): conversation_id is the single conversation → set conversation_platform_id only
      let workerPlatformId: string | undefined;
      let conversationPlatformId: string | undefined;
      if (run.conversation_id) {
        const conv = await conversationDb.getConversationById(run.conversation_id);
        if (run.parent_conversation_id) {
          // Web run: conversation_id points to the worker conversation
          workerPlatformId = conv?.platform_conversation_id;
        } else {
          // CLI run: conversation_id is the only conversation (no worker/parent split)
          conversationPlatformId = conv?.platform_conversation_id;
        }
      }

      // Look up parent conversation to get its platform_conversation_id for navigation
      let parentPlatformId: string | undefined;
      if (run.parent_conversation_id) {
        const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
        parentPlatformId = parentConv?.platform_conversation_id;
      }

      const terminalRecord = getTerminalRecord(run.status, events);
      return c.json({
        run: {
          ...toApiWorkflowRun(run),
          worker_platform_id: workerPlatformId,
          parent_platform_id: parentPlatformId,
          conversation_platform_id: conversationPlatformId ?? null,
          owner_observation: await observeRunOwner(createWorkflowStore(), run),
          terminal_record: terminalRecord,
          // The console reads node state from here and keeps no fold of its own.
          nodes: terminalRecord?.nodes ?? buildRunNodeStates(run, events),
        },
        // The console renders each cost's scope from here and keeps no copy of the rule.
        events: events.map(event =>
          typeof event.data.cost_usd === 'number'
            ? { ...event, cost_scope: nodeCostScope(event.data) }
            : event
        ),
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_workflow_run_failed');
      return apiError(c, 500, 'Failed to get workflow run');
    }
  });

  // GET /api/workflows/runs/:runId/provider-events - A run's provider events
  registerOpenApiRoute(getProviderEventsRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    const { step, attemptId, afterSeq } = (
      c.req as unknown as { valid(k: 'query'): z.infer<typeof providerEventsQuerySchema> }
    ).valid('query');
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) return apiError(c, 404, 'Workflow run not found');
      // Read through the engine's store seam, not the DB module.
      const events = await createWorkflowStore().listProviderEvents(
        runId,
        step !== undefined && attemptId !== undefined && afterSeq !== undefined
          ? { stepName: step, after: { attemptId, seq: afterSeq } }
          : { stepName: step }
      );
      return c.json({ events });
    } catch (error) {
      getLog().error({ err: error, runId }, 'list_provider_events_failed');
      return apiError(c, 500, 'Failed to list provider events');
    }
  });
}
