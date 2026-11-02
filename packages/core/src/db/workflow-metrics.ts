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
  codebase_id: string | null;
}

function readData(data: MetricCompletionRow['data']): Record<string, unknown> | undefined {
  let parsed: unknown = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** Unreadable data yields `undefined`, which `queryMetrics` reports as an invalid record. */
function readMetrics(data: Record<string, unknown> | undefined): unknown {
  const structured = data?.structured_output;
  if (typeof structured !== 'object' || structured === null) return undefined;
  return (structured as { metrics?: unknown }).metrics;
}

/**
 * The predicate must stay textually equal to idx_workflow_events_metrics, with the event
 * type as a literal: a partial index serves only a query whose WHERE clause contains the
 * index's own terms, and SQLite's `INDEXED BY` fails the query outright when it can't.
 */
export const metricRecordsSql = (dialect: SqlDialect): string =>
  `SELECT e.id, e.workflow_run_id, e.step_name, e.created_at, e.data, r.workflow_name, r.codebase_id
     FROM remote_agent_workflow_events e${dialect.indexedBy('idx_workflow_events_metrics')}
     JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id
     WHERE e.event_type = 'node_completed'
       AND ${dialect.jsonText('e.data', 'structured_output.metrics')} IS NOT NULL
     ORDER BY COALESCE(e.event_order, 0) ASC, e.created_at ASC, e.id ASC`;

export async function listMetricRecords(): Promise<MetricRecordRow[]> {
  const result = await pool.query<MetricCompletionRow>(metricRecordsSql(getDialect()));
  return result.rows.map(row => {
    const data = readData(row.data);
    return {
      eventId: row.id,
      runId: row.workflow_run_id,
      workflowName: row.workflow_name,
      codebaseId: row.codebase_id,
      nodeId: row.step_name,
      nodeType: typeof data?.type === 'string' ? data.type : null,
      completedAt: toHydratedTimestamp(row.created_at).toISOString(),
      metrics: readMetrics(data),
    };
  });
}
