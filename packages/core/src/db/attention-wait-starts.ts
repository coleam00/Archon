/**
 * The `wait_started` rows of attention waits. Rows are returned raw;
 * `countAttentionWaitStarts` in `@archon/workflows` owns which of them count.
 */
import type { AttentionWaitStart } from '@archon/workflows/store';
import { getDialect, pool } from './connection';
import { toHydratedTimestamp } from './timestamps';
import { parseJsonObject } from './workflow-run-normalization';

/** Every attention wait's `wait_started` row (see `IWorkflowStore.listAttentionWaitStarts`). */
export async function listAttentionWaitStarts(): Promise<AttentionWaitStart[]> {
  const result = await pool.query<{
    workflow_run_id: string;
    created_at: string | Date;
    data: string | Record<string, unknown>;
  }>(
    `SELECT e.workflow_run_id, e.created_at, e.data
     FROM remote_agent_workflow_events e
     JOIN remote_agent_workflow_runs r ON r.id = e.workflow_run_id
     WHERE e.event_type = 'wait_started' AND ${getDialect().jsonText('e.data', 'kind')} = 'attention'
     ORDER BY e.created_at ASC, e.id ASC`
  );
  return result.rows.map(row => ({
    runId: row.workflow_run_id,
    startedAt: toHydratedTimestamp(row.created_at).toISOString(),
    data: parseJsonObject(row.data) ?? {},
  }));
}
