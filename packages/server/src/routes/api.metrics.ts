import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  MetricsQueryError,
  queryMetrics,
  resolveCompareCut,
  resolveMetricsWindow,
  type MetricsStore,
} from '@archon/workflows/metrics';
import {
  apiError,
  getLog,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { metricsQuerySchema, metricsReportSchema } from './schemas/metrics.schemas';

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
    400: jsonError('Malformed window or compare cut'),
    500: jsonError('Server error'),
  },
});

export function registerMetricsRoute(app: OpenAPIHono, store: MetricsStore): void {
  openApiRouteRegistrar(app)(getMetricsRoute, async c => {
    const { since, until, name, subject, codebaseId, compare } = getValidatedQuery(
      c,
      metricsQuerySchema
    );
    let window: { since: Date; until: Date };
    let compareAt: Date | undefined;
    try {
      window = resolveMetricsWindow({ since, until });
      compareAt = compare === undefined ? undefined : resolveCompareCut(compare);
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
          ...(compareAt === undefined ? {} : { compareAt }),
        })
      );
    } catch (error) {
      getLog().error({ err: error }, 'query_metrics_failed');
      return apiError(c, 500, 'Failed to query metrics');
    }
  });
}
