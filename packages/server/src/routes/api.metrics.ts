import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { discoverMetricViews } from '@archon/workflows/metric-views';
import {
  MetricsQueryError,
  queryMetrics,
  resolveMetricsSplit,
  resolveMetricsWindow,
  type MetricsSplit,
  type MetricsStore,
} from '@archon/workflows/metrics';
import type { WorkflowConfig } from '@archon/workflows/deps';
import { liveSourceRoots, workflowSourceConfigFrom } from '@archon/workflows/workflow-source';
import {
  apiError,
  getLog,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import {
  metricsQuerySchema,
  metricsReportSchema,
  metricViewsSchema,
} from './schemas/metrics.schemas';

const getMetricsRoute = createRoute({
  method: 'get',
  path: '/api/metrics',
  tags: ['Workflows'],
  summary: 'Aggregate stored metric records by name, window and instrument',
  request: { query: metricsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: metricsReportSchema } },
      description: 'OK',
    },
    400: jsonError(
      'Malformed window or compare cut, compare with byModel, or a byModel node no producing run ran'
    ),
    500: jsonError('Server error'),
  },
});

export function registerMetricsRoute(app: OpenAPIHono, store: MetricsStore): void {
  openApiRouteRegistrar(app)(getMetricsRoute, async c => {
    const { since, until, name, subject, codebaseId, compare, byModel } = getValidatedQuery(
      c,
      metricsQuerySchema
    );
    let window: { since: Date; until: Date };
    let split: MetricsSplit;
    try {
      window = resolveMetricsWindow({ since, until });
      split = resolveMetricsSplit({ compare, byModel });
    } catch (error) {
      if (!(error instanceof MetricsQueryError)) throw error;
      return apiError(c, 400, error.message);
    }
    try {
      return c.json(
        await queryMetrics(store, {
          ...window,
          ...(name === undefined ? {} : { name }),
          ...(subject === undefined ? {} : { subject }),
          ...(codebaseId === undefined ? {} : { codebaseId }),
          ...split,
        })
      );
    } catch (error) {
      // A byModel node no producing run ran, listing the AI nodes they did run.
      if (error instanceof MetricsQueryError) return apiError(c, 400, error.message);
      getLog().error({ err: error }, 'query_metrics_failed');
      return apiError(c, 500, 'Failed to query metrics');
    }
  });
}

const metricViewsQuerySchema = z.object({
  codebaseId: z.string().optional().openapi({
    description:
      "Include this codebase's project packs. Without it, only bundled, home and installed packs.",
  }),
});

const getMetricViewsRoute = createRoute({
  method: 'get',
  path: '/api/metric-views',
  tags: ['Workflows'],
  summary: 'The overview cards workflow packs declare',
  request: { query: metricViewsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: metricViewsSchema } },
      description: 'OK',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

export function registerMetricViewsRoute(
  app: OpenAPIHono,
  deps: {
    codebaseCwd: (id: string) => Promise<string | null>;
    loadConfig: (cwd: string) => Promise<WorkflowConfig>;
  }
): void {
  openApiRouteRegistrar(app)(getMetricViewsRoute, async c => {
    const { codebaseId } = getValidatedQuery(c, metricViewsQuerySchema);
    let project: string | null = null;
    if (codebaseId !== undefined) {
      project = await deps.codebaseCwd(codebaseId);
      if (project === null) return apiError(c, 404, 'Codebase not found');
    }
    try {
      // Without a project there is no config to read; bundled packs load, as in workflow discovery.
      const roots =
        project === null
          ? liveSourceRoots(null)
          : liveSourceRoots(project, workflowSourceConfigFrom(await deps.loadConfig(project)));
      return c.json(await discoverMetricViews(roots));
    } catch (error) {
      getLog().error({ err: error, codebaseId }, 'discover_metric_views_failed');
      return apiError(c, 500, 'Failed to discover metric views');
    }
  });
}
