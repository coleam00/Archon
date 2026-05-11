/**
 * Database operations for workflow events (lean UI-relevant events).
 *
 * Stores step transitions, parallel agent status, artifacts, and errors.
 * Verbose assistant/tool content stays in JSONL logs only.
 *
 * All write operations use fire-and-forget pattern (catch + log, never throw)
 * because workflow execution must not fail due to event logging.
 * Read operations also throw on error — callers own the degradation policy.
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-events');
  return cachedLog;
}

export interface WorkflowEventRow {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  /** Normalized to object — SQLite returns JSON as string, PG returns object. */
  data: Record<string, unknown>;
  created_at: string;
}

/**
 * Create a workflow event. Fire-and-forget - never throws.
 */
export async function createWorkflowEvent(data: {
  workflow_run_id: string;
  event_type: string;
  step_index?: number;
  step_name?: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    const dialect = getDialect();
    const id = dialect.generateUuid();
    await pool.query(
      `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, step_index, step_name, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        data.workflow_run_id,
        data.event_type,
        data.step_index ?? null,
        data.step_name ?? null,
        JSON.stringify(data.data ?? {}),
      ]
    );
  } catch (error) {
    getLog().error(
      { err: error as Error, eventType: data.event_type, runId: data.workflow_run_id },
      'db.workflow_event_create_failed'
    );
    // Fire-and-forget: never throw
  }
}

/**
 * List all events for a workflow run, ordered by creation time.
 */
export async function listWorkflowEvents(workflowRunId: string): Promise<WorkflowEventRow[]> {
  try {
    const result = await pool.query<WorkflowEventRow>(
      `SELECT * FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1
       ORDER BY created_at ASC`,
      [workflowRunId]
    );
    return [...result.rows].map(row => ({
      ...row,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    }));
  } catch (error) {
    getLog().error({ err: error as Error, runId: workflowRunId }, 'db.workflow_events_list_failed');
    throw new Error(`Failed to list workflow events: ${(error as Error).message}`);
  }
}

/**
 * List recent events for a workflow run since a given timestamp.
 */
export async function listRecentEvents(
  workflowRunId: string,
  since?: Date
): Promise<WorkflowEventRow[]> {
  try {
    if (since) {
      const result = await pool.query<WorkflowEventRow>(
        `SELECT * FROM remote_agent_workflow_events
         WHERE workflow_run_id = $1 AND created_at > $2
         ORDER BY created_at ASC`,
        [workflowRunId, since.toISOString()]
      );
      return [...result.rows].map(row => ({
        ...row,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      }));
    }
    return await listWorkflowEvents(workflowRunId);
  } catch (error) {
    getLog().error(
      { err: error as Error, runId: workflowRunId },
      'db.workflow_events_list_recent_failed'
    );
    throw new Error(`Failed to list recent workflow events: ${(error as Error).message}`);
  }
}

/**
 * Return a map of nodeId → output for all node_completed events in a workflow run.
 * Used by the DAG executor to restore node outputs when resuming a failed run.
 * Throws on DB error — caller owns the degradation policy.
 */
export async function getCompletedDagNodeOutputs(
  workflowRunId: string
): Promise<Map<string, string>> {
  const result = await pool.query<{
    step_name: string | null;
    data: string | Record<string, unknown>;
  }>(
    `SELECT step_name, data FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1 AND event_type = 'node_completed'
     ORDER BY created_at ASC`,
    [workflowRunId]
  );
  const outputs = new Map<string, string>();
  for (const row of result.rows) {
    if (!row.step_name) continue;
    let data: Record<string, unknown>;
    try {
      data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch (parseErr) {
      getLog().warn(
        { err: parseErr as Error, runId: workflowRunId, stepName: row.step_name },
        'db.workflow_dag_node_output_parse_failed'
      );
      continue;
    }
    if (typeof data.node_output === 'string') {
      outputs.set(row.step_name, data.node_output);
    }
  }
  return outputs;
}
