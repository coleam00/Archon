import { captureWorkflowTerminal, createLogger, isTelemetryDisabled } from '@archon/paths';
import {
  buildRunTerminalTelemetry,
  type RunTelemetryEvent,
} from '@archon/workflows/run-terminal-telemetry';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { pool } from './connection';
import { getDagResumeSnapshot } from './workflow-events';
import { normalizeWorkflowRun } from './workflow-run-normalization';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-terminal-telemetry');
  return cachedLog;
}

/**
 * Report a run's committed terminal transition to anonymous telemetry. Every
 * terminal writer in this module calls it once, after its transaction commits
 * and only when its status CAS won — so each transition is reported exactly
 * once, never before the write, whichever caller ended the run.
 *
 * Best-effort: the status write is authoritative. A failure here is logged and
 * reports nothing for that run; it never fails the caller.
 */
export async function reportRunTerminal(runId: string): Promise<void> {
  if (isTelemetryDisabled()) return;
  try {
    const runResult = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [runId]
    );
    const run = runResult.rows[0];
    if (!run) return;
    const events = await pool.query<RunTelemetryEvent>(
      `SELECT event_type, step_name, data, created_at FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1
       ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
      [runId]
    );
    const usage = await getDagResumeSnapshot(runId);
    const telemetry = buildRunTerminalTelemetry({
      run: normalizeWorkflowRun(run),
      events: events.rows,
      usage: { costUsd: usage.costUsd, tokens: usage.tokens },
    });
    if (telemetry) captureWorkflowTerminal(telemetry);
  } catch (error) {
    getLog().warn(
      { err: error as Error, workflowRunId: runId },
      'db.run_terminal_telemetry_failed'
    );
  }
}
