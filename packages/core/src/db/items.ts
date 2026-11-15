/** Items: the durable thing runs are about. A row holds a key, its project and nothing else. */
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import {
  assertItemKey,
  type WorkflowItem,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { pool } from './connection';
import type { TransactionQuery } from './resource-slots';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';

/**
 * The item `key` names in a codebase's project, written on first use; naming it again is
 * the same item. An item is keyed on the engine's project key, not the codebase row.
 */
export async function ensureItem(
  query: TransactionQuery,
  codebaseId: string | undefined,
  key: string
): Promise<string> {
  assertItemKey(key);
  const codebases = await query<{ kind: string | null; name: string; default_cwd: string }>(
    'SELECT kind, name, default_cwd FROM remote_agent_codebases WHERE id = $1',
    [codebaseId ?? null]
  );
  const codebase = codebases.rows[0];
  if (!codebase) throw new Error('naming an item needs a registered project');
  const named = [projectKeyForCodebase(codebase, codebase.default_cwd), key];
  await query(
    'INSERT INTO remote_agent_items (project_key, key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    named
  );
  const found = await query<{ id: string }>(
    'SELECT id FROM remote_agent_items WHERE project_key = $1 AND key = $2',
    named
  );
  if (!found.rows[0]) throw new Error(`Item '${key}' was not written`);
  return found.rows[0].id;
}

/** Every run of one item in a project, in the order they started. */
export async function listItemRuns(projectKey: string, itemKey: string): Promise<WorkflowRun[]> {
  const result = await pool.query<WorkflowRunRow>(
    `SELECT r.*, CAST(r.origin AS TEXT) AS origin FROM remote_agent_workflow_runs r
       JOIN remote_agent_items i ON i.id = r.item_id
      WHERE i.project_key = $1 AND i.key = $2 ORDER BY r.started_at, r.id`,
    [projectKey, itemKey]
  );
  return result.rows.map(normalizeWorkflowRun);
}

export async function getItem(id: string): Promise<WorkflowItem | null> {
  const result = await pool.query<{ id: string; project_key: string; key: string }>(
    'SELECT id, project_key, key FROM remote_agent_items WHERE id = $1',
    [id]
  );
  const row = result.rows[0];
  return row ? { id: row.id, projectKey: row.project_key, key: row.key } : null;
}
