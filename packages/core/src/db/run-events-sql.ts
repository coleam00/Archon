/**
 * `columns` of the rows of `runCount` runs (`$1..`) with one of `typeCount` event types
 * (the following parameters), each run's rows in durable event order. Served by
 * idx_workflow_events_run_type, which reads only the requested types of each run.
 */
export function runEventsSql(columns: string, runCount: number, typeCount: number): string {
  const placeholders = (count: number, offset: number): string =>
    Array.from({ length: count }, (_, index) => `$${String(offset + index + 1)}`).join(', ');
  return `SELECT ${columns} FROM remote_agent_workflow_events
     WHERE workflow_run_id IN (${placeholders(runCount, 0)})
       AND event_type IN (${placeholders(typeCount, runCount)})
     ORDER BY workflow_run_id, COALESCE(event_order, 0) ASC, created_at ASC, id ASC`;
}
