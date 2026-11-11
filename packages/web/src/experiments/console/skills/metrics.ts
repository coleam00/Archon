import type { QueryParams } from '../lib/api-types';
import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

export type MetricsReport = components['schemas']['MetricsReport'];
export type MetricViews = components['schemas']['MetricViews'];

export type GetMetricsOptions = QueryParams<'/api/metrics', 'get'> &
  Required<Pick<QueryParams<'/api/metrics', 'get'>, 'since'>>;

export async function getMetrics(opts: GetMetricsOptions): Promise<MetricsReport> {
  return requestJson('/api/metrics', 'get', { query: opts });
}

/** The overview cards packs declare; a project's own packs only when scoped to it. */
export async function getMetricViews(
  opts: QueryParams<'/api/metric-views', 'get'>
): Promise<MetricViews> {
  return requestJson('/api/metric-views', 'get', { query: opts });
}
