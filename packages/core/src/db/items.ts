/** Items: the durable thing runs are about. A row holds a key, its project and nothing else. */
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import {
  assertItemKey,
  ContinuedItemProjectError,
  type WorkflowItem,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { getDatabaseType, pool } from './connection';
import type { TransactionQuery } from './resource-slots';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getLog } from './workflow-run-shared';

/**
 * The item `key` names in a codebase's project, written on first use; naming it again is
 * the same item. An item is keyed on the engine's project key, not the codebase row.
 */
export async function ensureItem(
  query: TransactionQuery,
  codebaseId: string | undefined,
  key: string
): Promise<string> {
  const project = await codebaseProjectKey(query, codebaseId);
  if (!project) throw new Error('naming an item needs a registered project');
  return ensureItemInProject(query, project, key);
}

/** The item `key` names in project `projectKey`, written on first use. */
export async function ensureItemInProject(
  query: TransactionQuery,
  projectKey: string,
  key: string
): Promise<string> {
  assertItemKey(key);
  const named = [projectKey, key];
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

/** The engine's project key of a registered codebase; null when there is none. */
async function codebaseProjectKey(
  query: TransactionQuery,
  codebaseId: string | undefined
): Promise<string | null> {
  const codebases = await query<{ kind: string | null; name: string; default_cwd: string }>(
    'SELECT kind, name, default_cwd FROM remote_agent_codebases WHERE id = $1',
    [codebaseId ?? null]
  );
  const codebase = codebases.rows[0];
  return codebase ? projectKeyForCodebase(codebase, codebase.default_cwd) : null;
}

/**
 * The item of the run a continuation adopts or supersedes: the same row, by id, so a fix
 * round or a rerun stays on its item. Null when that run has none. An item belongs to one
 * project, so a continuation in another project is refused instead of leaving the item.
 */
export async function continuedItem(
  query: TransactionQuery,
  codebaseId: string | undefined,
  continuedRunId: string
): Promise<string | null> {
  const continued = await query<{ id: string; project_key: string; key: string }>(
    `SELECT i.id, i.project_key, i.key FROM remote_agent_workflow_runs r
       JOIN remote_agent_items i ON i.id = r.item_id WHERE r.id = $1`,
    [continuedRunId]
  );
  const item = continued.rows[0];
  if (!item) return null;
  const project = await codebaseProjectKey(query, codebaseId);
  if (project !== item.project_key)
    throw new ContinuedItemProjectError(
      `Run ${continuedRunId} is on item '${item.key}' in project '${item.project_key}', but its continuation runs in ${project ? `project '${project}'` : 'no registered project'}. An item belongs to one project, so the continuation has to name its own item.`
    );
  return item.id;
}

/**
 * The item `itemKey` names in a project and its runs, in the order they started; null when
 * the project has no item under that key. A named item may have no run yet.
 */
export async function getItemRuns(
  projectKey: string,
  itemKey: string
): Promise<{
  item: WorkflowItem;
  runs: AttentionRead<WorkflowRun>[];
  descendantIds: string[];
} | null> {
  const found = await pool.query<{ id: string; project_key: string; key: string }>(
    'SELECT id, project_key, key FROM remote_agent_items WHERE project_key = $1 AND key = $2',
    [projectKey, itemKey]
  );
  const row = found.rows[0];
  if (!row) return null;
  // SQLite records started_at to the second, so runs that start in one second tie; its
  // rowid is insertion order and breaks the tie truly. PostgreSQL records microseconds.
  const tieBreak = getDatabaseType() === 'sqlite' ? 'r.rowid' : 'r.id';
  const result = await pool.query<WorkflowRunRow>(
    `SELECT r.*, CAST(r.origin AS TEXT) AS origin FROM remote_agent_workflow_runs r
      WHERE r.item_id = $1 ORDER BY r.started_at, ${tieBreak}`,
    [row.id]
  );
  const runs = result.rows.map((run): AttentionRead<WorkflowRun> => {
    try {
      return normalizeWorkflowRun(run);
    } catch {
      // Parser errors can quote stored data, including message text.
      getLog().error({ workflowRunId: run.id }, 'item_run_normalization_failed');
      return { type: 'degraded', reason: 'run_unreadable', runId: run.id };
    }
  });
  return {
    item: { id: row.id, projectKey: row.project_key, key: row.key },
    runs,
    descendantIds: await descendantRunIds(result.rows.map(run => run.id)),
  };
}

/**
 * Every run below `roots` by `parent_run_id`, reading ids only. Unbounded, unlike
 * `gatherDescendantRunIds`: a fan-out has no limit on its children, and a cut-off walk
 * would report an item with an open question as having none. `parent_run_id` is written
 * only when a run is created, naming a run that already exists, so the walk cannot cycle.
 */
async function descendantRunIds(roots: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const queue = [...roots];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const children = await pool.query<{ id: string }>(
      'SELECT id FROM remote_agent_workflow_runs WHERE parent_run_id = $1 ORDER BY started_at, id',
      [id]
    );
    for (const child of children.rows) {
      found.push(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

export async function getItem(id: string): Promise<WorkflowItem | null> {
  const result = await pool.query<{ id: string; project_key: string; key: string }>(
    'SELECT id, project_key, key FROM remote_agent_items WHERE id = $1',
    [id]
  );
  const row = result.rows[0];
  return row ? { id: row.id, projectKey: row.project_key, key: row.key } : null;
}
