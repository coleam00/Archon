import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

export type MetricsReport = components['schemas']['MetricsReport'];
export type MetricViews = components['schemas']['MetricViews'];

export interface GetMetricsOptions {
  /** A window start in the API's syntax, such as `30d`. */
  since: string;
  codebaseId?: string;
}

export async function getMetrics(opts: GetMetricsOptions): Promise<MetricsReport> {
  const qs = new URLSearchParams({ since: opts.since });
  if (opts.codebaseId !== undefined) qs.set('codebaseId', opts.codebaseId);
  return requestJson<MetricsReport>(`/api/metrics?${qs.toString()}`);
}

/** The overview cards packs declare; a project's own packs only when scoped to it. */
export async function getMetricViews(opts: { codebaseId?: string }): Promise<MetricViews> {
  const qs = opts.codebaseId === undefined ? '' : `?${new URLSearchParams(opts).toString()}`;
  return requestJson<MetricViews>(`/api/metric-views${qs}`);
}
