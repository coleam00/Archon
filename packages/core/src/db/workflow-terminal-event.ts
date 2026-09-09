import { buildTerminalRecord, type TerminalRecordEvent } from '@archon/workflows/terminal-record';
import type { WorkflowRun, RunTerminalStatus } from '@archon/workflows/schemas/workflow-run';
import type { IDatabase } from './adapters/types';
import { normalizeWorkflowRun } from './workflow-run-normalization';
import { insertWorkflowEvent, type WorkflowEventInput } from './workflow-events';

/** The winning status update, its projection, and its event share this transaction. */
export async function insertTerminalWorkflowEvent(
  query: IDatabase['query'],
  event: WorkflowEventInput & {
    event_type: `workflow_${RunTerminalStatus}`;
  }
): Promise<void> {
  const runResult = await query<WorkflowRun>(
    'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
    [event.workflow_run_id]
  );
  const run = runResult.rows[0];
  if (!run) throw new Error(`Terminal workflow run disappeared: ${event.workflow_run_id}`);
  const eventResult = await query<TerminalRecordEvent>(
    `SELECT event_type, step_name, data FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1
     ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
    [event.workflow_run_id]
  );
  const terminalRecord = await buildTerminalRecord({
    run: normalizeWorkflowRun(run),
    events: eventResult.rows,
  });
  await insertWorkflowEvent(query, {
    ...event,
    data: { ...event.data, terminal_record: terminalRecord },
  });
}
