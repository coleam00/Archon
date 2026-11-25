/**
 * The event rows the attention surfaces read across the whole install: the `wait_started`
 * rows of attention waits and the `workflow_notice` rows. Rows are returned raw;
 * `countAttentionWaitStarts` and `listWorkflowNotices` in `@archon/workflows` own which
 * of them count.
 */
import type { AttentionWaitStart, WorkflowNoticeRow } from '@archon/workflows/store';
import { getDialect, pool } from './connection';
import { toHydratedTimestamp } from './timestamps';
import { parseJsonObject } from './workflow-run-normalization';

interface EventRow {
  runId: string;
  at: string;
  data: Record<string, unknown>;
}

/**
 * Rows of one event type, oldest first, for runs that still exist. `filter` is trusted
 * SQL. Timestamps can tie, so the feed's append order settles rows of one moment.
 */
async function listEventRows(eventType: string, filter = ''): Promise<EventRow[]> {
  const result = await pool.query<{
    workflow_run_id: string;
    created_at: string | Date;
    data: string | Record<string, unknown>;
  }>(
    `SELECT e.workflow_run_id, e.created_at, e.data
     FROM remote_agent_workflow_events e
     JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id
     WHERE e.event_type = $1${filter}
     ORDER BY e.created_at ASC, COALESCE(e.event_order, 0) ASC, e.id ASC`,
    [eventType]
  );
  return result.rows.map(row => ({
    runId: row.workflow_run_id,
    at: toHydratedTimestamp(row.created_at).toISOString(),
    data: parseJsonObject(row.data) ?? {},
  }));
}

/** Every attention wait's `wait_started` row (see `IWorkflowStore.listAttentionWaitStarts`). */
export async function listAttentionWaitStarts(): Promise<AttentionWaitStart[]> {
  const rows = await listEventRows(
    'wait_started',
    ` AND ${getDialect().jsonText('e.data', 'kind')} = 'attention'`
  );
  return rows.map(({ runId, at, data }) => ({ runId, startedAt: at, data }));
}

/** Every `workflow_notice` row (see `IWorkflowStore.listWorkflowNoticeRows`). */
export async function listWorkflowNoticeRows(): Promise<WorkflowNoticeRow[]> {
  return listEventRows('workflow_notice');
}
