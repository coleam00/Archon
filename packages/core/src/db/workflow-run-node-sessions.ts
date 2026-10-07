/** Private provider session handles scoped to a single workflow run. */
import { createLogger } from '@archon/paths';
import type { WorkflowRunNodeSession } from '@archon/workflows/schemas/workflow-run-node-session';
import type { IWorkflowRunNodeSessionStore } from '@archon/workflows/store';
import { getDialect, pool } from './connection';

import { toHydratedTimestamp } from './timestamps';

type SessionRow = Omit<WorkflowRunNodeSession, 'created_at' | 'updated_at'> & {
  created_at: string | Date;
  updated_at: string | Date;
};

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-run-node-sessions');
  return cachedLog;
}

export async function listWorkflowRunNodeSessions(
  workflowRunId: string
): Promise<readonly WorkflowRunNodeSession[]> {
  const result = await pool.query<SessionRow>(
    `SELECT * FROM remote_agent_workflow_run_node_sessions
     WHERE workflow_run_id = $1
     ORDER BY node_id ASC`,
    [workflowRunId]
  );
  return result.rows.map(row => ({
    ...row,
    created_at: toHydratedTimestamp(row.created_at).toISOString(),
    updated_at: toHydratedTimestamp(row.updated_at).toISOString(),
  }));
}

export const upsertWorkflowRunNodeSession: IWorkflowRunNodeSessionStore['upsertWorkflowRunNodeSession'] =
  async params => {
    const now = getDialect().now();
    try {
      await pool.query(
        `INSERT INTO remote_agent_workflow_run_node_sessions
           (workflow_run_id, node_id, provider, provider_session_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, ${now}, ${now})
         ON CONFLICT (workflow_run_id, node_id)
         DO UPDATE SET provider = EXCLUDED.provider,
                       provider_session_id = EXCLUDED.provider_session_id,
                       updated_at = ${now}`,
        [params.workflow_run_id, params.node_id, params.provider, params.provider_session_id]
      );
      getLog().debug(
        {
          workflowRunId: params.workflow_run_id,
          nodeId: params.node_id,
          provider: params.provider,
        },
        'db.workflow_run_node_session_upsert_completed'
      );
    } catch (error) {
      getLog().error(
        {
          err: error as Error,
          workflowRunId: params.workflow_run_id,
          nodeId: params.node_id,
          provider: params.provider,
        },
        'db.workflow_run_node_session_upsert_failed'
      );
      throw error;
    }
  };
