/**
 * Metric completions: `node_completed` rows whose structured output carries the
 * reserved `metrics` key. Rows are returned raw; `queryMetrics` in
 * `@archon/workflows` owns every rule about which of them count.
 */
import type { MetricRecordRow } from '@archon/workflows/store';
import type { SqlDialect } from './adapters/types';
import { pool, getDialect } from './connection';
import { toHydratedTimestamp } from './timestamps';

interface MetricCompletionRow {
  id: string;
  workflow_run_id: string;
  step_name: string;
  created_at: string | Date;
  data: string | Record<string, unknown> | null;
  workflow_name: string;
}

/** Unreadable data yields `undefined`, which `queryMetrics` reports as an invalid record. */
function readMetrics(data: MetricCompletionRow['data']): unknown {
  let parsed: unknown = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const structured = (parsed as { structured_output?: unknown }).structured_output;
  if (typeof structured !== 'object' || structured === null) return undefined;
  return (structured as { metrics?: unknown }).metrics;
}

/**
 * The predicate must stay textually equal to idx_workflow_events_metrics, with the event
 * type as a literal: a partial index serves only a query whose WHERE clause contains the
 * index's own terms, and SQLite's `INDEXED BY` fails the query outright when it can't.
 */
export function metricRecordsSql(dialect: SqlDialect, byCodebase: boolean): string {
  return `SELECT e.id, e.workflow_run_id, e.step_name, e.created_at, e.data, r.workflow_name
     FROM remote_agent_workflow_events e${dialect.indexedBy('idx_workflow_events_metrics')}
     JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id
     WHERE e.event_type = 'node_completed'
       AND ${dialect.jsonText('e.data', 'structured_output.metrics')} IS NOT NULL
       ${byCodebase ? 'AND r.codebase_id = $1' : ''}
     ORDER BY COALESCE(e.event_order, 0) ASC, e.created_at ASC, e.id ASC`;
}

export async function listMetricRecords(query: {
  codebaseId?: string;
}): Promise<MetricRecordRow[]> {
  const byCodebase = query.codebaseId !== undefined;
  const result = await pool.query<MetricCompletionRow>(
    metricRecordsSql(getDialect(), byCodebase),
    byCodebase ? [query.codebaseId] : []
  );
  return result.rows.map(row => ({
    eventId: row.id,
    runId: row.workflow_run_id,
    workflowName: row.workflow_name,
    nodeId: row.step_name,
    completedAt: toHydratedTimestamp(row.created_at).toISOString(),
    metrics: readMetrics(row.data),
  }));
}
