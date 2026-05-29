/**
 * Database operations for per-node provider sessions persisted across workflow re-runs.
 *
 * Distinct from `AgentRequestOptions.persistSession` (Claude SDK on-disk transcript flag).
 * This table stores the provider's session ID returned in the result `MessageChunk`
 * (see `@archon/providers/types`) so the DAG executor can pass it back as
 * `resumeSessionId` on a subsequent workflow run with the same scope (typically
 * `conversation_id`).
 *
 * No cascade is wired into conversation deletion: conversation deletion is a soft
 * delete and `scope_key` is the conversation UUID (never reused), so any rows left
 * behind are unreachable and harmless. If a hard-delete path is ever introduced, it
 * should delete rows for the affected `scope_key` there (scope_key is FK-free
 * polymorphic TEXT, so the DB will not cascade on its own).
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';
import type { WorkflowNodeSession } from '@archon/workflows/schemas/workflow-node-session';
import type { WorkflowNodeSessionKey } from '@archon/workflows/store';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-node-sessions');
  return cachedLog;
}

export async function getWorkflowNodeSession(
  key: WorkflowNodeSessionKey
): Promise<WorkflowNodeSession | null> {
  const result = await pool.query<WorkflowNodeSession>(
    `SELECT * FROM remote_agent_workflow_node_sessions
     WHERE workflow_name = $1 AND node_id = $2 AND scope_key = $3 AND provider = $4`,
    [key.workflow_name, key.node_id, key.scope_key, key.provider]
  );
  return result.rows[0] ?? null;
}

export async function upsertWorkflowNodeSession(
  params: WorkflowNodeSessionKey & {
    provider_session_id: string;
    last_run_id: string | null;
  }
): Promise<void> {
  const dialect = getDialect();
  const now = dialect.now();
  try {
    await pool.query(
      `INSERT INTO remote_agent_workflow_node_sessions
         (workflow_name, node_id, scope_key, provider, provider_session_id, last_run_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${now}, ${now})
       ON CONFLICT (workflow_name, node_id, scope_key, provider)
       DO UPDATE SET provider_session_id = EXCLUDED.provider_session_id,
                     last_run_id = EXCLUDED.last_run_id,
                     updated_at = ${now}`,
      [
        params.workflow_name,
        params.node_id,
        params.scope_key,
        params.provider,
        params.provider_session_id,
        params.last_run_id,
      ]
    );
    getLog().debug(
      {
        workflowName: params.workflow_name,
        nodeId: params.node_id,
        scopeKey: params.scope_key,
        provider: params.provider,
      },
      'db.workflow_node_session_upsert_completed'
    );
  } catch (error) {
    getLog().error(
      {
        err: error as Error,
        workflowName: params.workflow_name,
        nodeId: params.node_id,
        scopeKey: params.scope_key,
        provider: params.provider,
      },
      'db.workflow_node_session_upsert_failed'
    );
    throw error;
  }
}

export async function deleteWorkflowNodeSessions(filter: {
  workflow_name: string;
  scope_key?: string;
  node_id?: string;
  provider?: string;
}): Promise<{ deleted: number }> {
  const params: unknown[] = [filter.workflow_name];
  let sql = 'DELETE FROM remote_agent_workflow_node_sessions WHERE workflow_name = $1';
  if (filter.scope_key !== undefined) {
    params.push(filter.scope_key);
    sql += ` AND scope_key = $${params.length}`;
  }
  if (filter.node_id !== undefined) {
    params.push(filter.node_id);
    sql += ` AND node_id = $${params.length}`;
  }
  if (filter.provider !== undefined) {
    params.push(filter.provider);
    sql += ` AND provider = $${params.length}`;
  }
  const result = await pool.query(sql, params);
  const deleted = result.rowCount ?? 0;
  getLog().info(
    {
      workflowName: filter.workflow_name,
      scopeKey: filter.scope_key,
      nodeId: filter.node_id,
      provider: filter.provider,
      deleted,
    },
    'db.workflow_node_sessions_delete_completed'
  );
  return { deleted };
}
