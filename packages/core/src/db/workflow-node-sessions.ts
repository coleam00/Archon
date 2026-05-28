/**
 * Database operations for per-node provider sessions persisted across workflow re-runs.
 *
 * Distinct from `AgentRequestOptions.persistSession` (Claude SDK on-disk transcript flag).
 * This table stores the provider's session ID returned in the result MessageChunk so the
 * DAG executor can pass it back as `resumeSessionId` on a subsequent workflow run with
 * the same scope (typically conversation_id).
 *
 * Cascade-on-conversation-delete is handled by the conversation deletion handler
 * (explicit, not FK) since scope_key is polymorphic TEXT.
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-node-sessions');
  return cachedLog;
}

export interface WorkflowNodeSessionRow {
  workflow_name: string;
  node_id: string;
  scope_key: string;
  provider: string;
  provider_session_id: string;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function getWorkflowNodeSession(
  workflow_name: string,
  node_id: string,
  scope_key: string,
  provider: string
): Promise<WorkflowNodeSessionRow | null> {
  const result = await pool.query<WorkflowNodeSessionRow>(
    `SELECT * FROM remote_agent_workflow_node_sessions
     WHERE workflow_name = $1 AND node_id = $2 AND scope_key = $3 AND provider = $4`,
    [workflow_name, node_id, scope_key, provider]
  );
  return result.rows[0] ?? null;
}

export async function upsertWorkflowNodeSession(params: {
  workflow_name: string;
  node_id: string;
  scope_key: string;
  provider: string;
  provider_session_id: string;
  last_run_id: string;
}): Promise<void> {
  const dialect = getDialect();
  const now = dialect.now();
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
}

export async function deleteWorkflowNodeSessions(filter: {
  workflow_name: string;
  scope_key?: string;
  node_id?: string;
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
  const result = await pool.query(sql, params);
  const deleted = result.rowCount ?? 0;
  getLog().info(
    {
      workflowName: filter.workflow_name,
      scopeKey: filter.scope_key,
      nodeId: filter.node_id,
      deleted,
    },
    'db.workflow_node_sessions_delete_completed'
  );
  return { deleted };
}

/**
 * Delete every row tied to a scope_key. Called from the conversation deletion path
 * because scope_key is FK-free (polymorphic TEXT).
 */
export async function deleteWorkflowNodeSessionsByScope(
  scope_key: string
): Promise<{ deleted: number }> {
  const result = await pool.query(
    'DELETE FROM remote_agent_workflow_node_sessions WHERE scope_key = $1',
    [scope_key]
  );
  const deleted = result.rowCount ?? 0;
  getLog().info(
    { scopeKey: scope_key, deleted },
    'db.workflow_node_sessions_scope_cascade_completed'
  );
  return { deleted };
}
