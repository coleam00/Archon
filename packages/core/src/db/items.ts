/** Items: the durable thing runs are about. A row holds a key, its project and nothing else. */
import { projectKeyForCodebase } from '@archon/paths/archon-paths';
import type { AttentionRead } from '@archon/workflows/schemas/attention-degraded';
import {
  assertItemKey,
  ContinuedItemProjectError,
  type WorkflowItem,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDatabaseType, pool } from './connection';
import type { TransactionQuery } from './resource-slots';
import {
  normalizeWorkflowRun,
  parseJsonObject,
  type WorkflowRunRow,
} from './workflow-run-normalization';
import { getLog } from './workflow-run-shared';

interface ItemRow {
  id: string;
  project_key: string;
  key: string;
  title: string | null;
}
/** The columns every read of an item takes, from `remote_agent_items i`. */
const ITEM_COLUMNS = 'i.id, i.project_key, i.key, i.title';
const itemOf = (row: ItemRow): WorkflowItem => ({
  id: row.id,
  projectKey: row.project_key,
  key: row.key,
  title: row.title,
});

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
  const found = await pool.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM remote_agent_items i WHERE i.project_key = $1 AND i.key = $2`,
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
      // Elsewhere metadata that does not read is taken as empty; on an item that would read
      // as a run that recorded nothing, such as no run config, so a later start would
      // silently run without the item's config.
      if (run.metadata !== null && parseJsonObject(run.metadata) === null)
        throw new Error('unreadable metadata');
      return normalizeWorkflowRun(run);
    } catch {
      // Parser errors can quote stored data, including message text.
      getLog().error({ workflowRunId: run.id }, 'item_run_normalization_failed');
      return { type: 'degraded', reason: 'run_unreadable', runId: run.id };
    }
  });
  return {
    item: itemOf(row),
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
  const result = await pool.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM remote_agent_items i WHERE i.id = $1`,
    [id]
  );
  const row = result.rows[0];
  return row ? itemOf(row) : null;
}

/**
 * The items of a project with one of their own runs started in `[since, until)`, ordered
 * by id, after `afterItemId` when given. The order is the key a cursor resumes from, not a
 * ranking.
 */
export async function listItemsInWindow(query: {
  projectKey: string;
  since: Date;
  until: Date;
  afterItemId: string | null;
  limit: number;
}): Promise<WorkflowItem[]> {
  const params: unknown[] = [
    query.projectKey,
    query.since.toISOString(),
    query.until.toISOString(),
  ];
  // Julian days compare SQLite's datetime('now') text with an ISO parameter correctly.
  const [from, to] =
    getDatabaseType() === 'sqlite'
      ? ['julianday(r.started_at) >= julianday($2)', 'julianday(r.started_at) < julianday($3)']
      : ['r.started_at >= $2::timestamptz', 'r.started_at < $3::timestamptz'];
  let after = '';
  if (query.afterItemId !== null) {
    params.push(query.afterItemId);
    after = `AND CAST(i.id AS TEXT) > $${String(params.length)}`;
  }
  params.push(query.limit);
  const result = await pool.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM remote_agent_items i
      WHERE i.project_key = $1 ${after}
        AND EXISTS (SELECT 1 FROM remote_agent_workflow_runs r
                     WHERE r.item_id = i.id AND ${from} AND ${to})
      ORDER BY CAST(i.id AS TEXT) LIMIT $${String(params.length)}`,
    params
  );
  return result.rows.map(itemOf);
}

/**
 * Set the title of the item `key` names in a project, writing the item on first use, so a
 * title can be given before the item has a run. Setting it again replaces it.
 */
export async function recordItemTitle(input: {
  projectKey: string;
  key: string;
  title: string;
}): Promise<WorkflowItem> {
  return getDatabase().withTransaction(async query => {
    const id = await ensureItemInProject(query, input.projectKey, input.key);
    await query('UPDATE remote_agent_items SET title = $1 WHERE id = $2', [input.title, id]);
    return { id, projectKey: input.projectKey, key: input.key, title: input.title };
  });
}
