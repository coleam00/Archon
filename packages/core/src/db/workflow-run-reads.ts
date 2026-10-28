import {
  STALE_PENDING_AGE_MS,
  WORKFLOW_PATH_LOCK_STATUSES,
} from '@archon/workflows/workflow-path-lock';
/**
 * Point reads of workflow runs: lookups by id, conversation, path, parent and
 * worker platform id. Re-exported from the `./workflows` entry.
 */
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import { getDatabaseType, getDialect, pool } from './connection';
import type { TransactionQuery } from './resource-slots';
import { notOriginAnchor } from './workflow-origin-anchor';
import { normalizeWorkflowRun, type WorkflowRunRow } from './workflow-run-normalization';
import { getLog } from './workflow-run-shared';
import { readWorkflowRunStatus } from './workflow-run-status';

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRunRow>(
      'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_failed');
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }
}

/**
 * Find the newest run with `metadata.isolation_env_id === envId` for container
 * listing. A null result only means no metadata match; cleanup uses
 * `getLiveRunOwningEnv` to check wider ownership before removing an environment.
 */
export async function getRunByIsolationEnvId(envId: string): Promise<WorkflowRun | null> {
  const extract = getDialect().jsonText('metadata', 'isolation_env_id');
  const result = await pool
    .query<Omit<WorkflowRunRow, 'status'> & { status: string }>(
      `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
     WHERE ${extract} = $1
     ORDER BY started_at DESC LIMIT 1`,
      [envId]
    )
    .catch((error: unknown) => {
      const err = error as Error;
      getLog().error({ err, envId }, 'db.workflow_run_get_by_isolation_env_failed');
      throw new Error(`Failed to look up run for isolation env ${envId}: ${err.message}`);
    });
  const row = result.rows[0];
  return row
    ? normalizeWorkflowRun({ ...row, status: readWorkflowRunStatus(row.id, row.status) })
    : null;
}

/**
 * Find runs in a codebase whose id starts with `idPrefix` (e.g. the 8-char
 * short id shown in listings). Returns up to two matches so callers can detect
 * an ambiguous prefix. Scoped to `codebaseId` in the query, so it never crosses
 * projects. Run ids are UUIDs, so `idPrefix` is rejected unless it's within the
 * UUID charset — that keeps it out of LIKE-wildcard territory (`%` / `_`).
 */
export async function findWorkflowRunsByIdPrefix(
  idPrefix: string,
  codebaseId: string
): Promise<WorkflowRun[]> {
  if (idPrefix.length === 0 || !/^[0-9a-fA-F-]+$/.test(idPrefix)) return [];
  try {
    const result = await pool.query<WorkflowRunRow>(
      'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE codebase_id = $1 AND CAST(id AS TEXT) LIKE $2 LIMIT 2',
      [codebaseId, `${idPrefix.toLowerCase()}%`]
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_find_by_prefix_failed');
    throw new Error(`Failed to find workflow runs by id prefix: ${err.message}`);
  }
}

export { WorkflowStatusReadError } from './workflow-run-status';

export async function getWorkflowRunStatus(id: string): Promise<WorkflowRunStatus | null> {
  const result = await pool
    .query<{ status: string }>('SELECT status FROM remote_agent_workflow_runs WHERE id = $1', [id])
    .catch((error: unknown) => {
      const err = error as Error;
      getLog().error({ err }, 'db.workflow_run_get_status_failed');
      throw new Error(`Failed to get workflow run status: ${err.message}`);
    });
  const row = result.rows[0];
  if (!row) return null;
  return readWorkflowRunStatus(id, row.status);
}

export async function getActiveWorkflowRun(
  conversationId: string,
  codebaseId?: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRunRow>(
      `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2) AND status = 'running'
       ${codebaseId ? 'AND codebase_id = $3' : ''}
       ORDER BY started_at DESC LIMIT 1`,
      codebaseId ? [conversationId, conversationId, codebaseId] : [conversationId, conversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_active_failed');
    throw new Error(`Failed to get active workflow run: ${err.message}`);
  }
}

/**
 * Find the newest paused run associated with a conversation, optionally within a project.
 * Used by the message handler to give the chat agent the open approval gate as
 * context for the turn (#2565).
 * Non-throwing: returns null on DB error so the caller can fall through to normal routing.
 */
export async function getPausedWorkflowRun(
  conversationId: string,
  codebaseId?: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRunRow>(
      `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2) AND status = 'paused'
       ${codebaseId ? 'AND codebase_id = $3' : ''}
       ORDER BY started_at DESC LIMIT 1`,
      codebaseId ? [conversationId, conversationId, codebaseId] : [conversationId, conversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId }, 'db.workflow_run_get_paused_failed');
    return null;
  }
}

export { STALE_PENDING_AGE_MS } from '@archon/workflows/workflow-path-lock';

export function activeWorkflowPathHolderCondition(): string {
  const cutoff =
    getDatabaseType() === 'postgresql'
      ? `NOW() - INTERVAL '${String(STALE_PENDING_AGE_MS)} milliseconds'`
      : `datetime('now', '-${String(Math.floor(STALE_PENDING_AGE_MS / 1000))} seconds')`;
  const statuses = WORKFLOW_PATH_LOCK_STATUSES.map(status => `'${status}'`).join(', ');
  return `(status IN (${statuses}) OR (status = 'pending' AND started_at > ${cutoff}))`;
}

/**
 * Find the workflow run currently holding the lock on `workingPath`.
 *
 * The lock is held by any row in `(running, paused)` or `pending` younger
 * than `STALE_PENDING_AGE_MS` (orphaned pre-creates beyond that window are
 * ignored — they're from crashed or resume-replaced dispatches).
 *
 * When called from a dispatch that already pre-created its own row, pass
 * `self` (`id` + `startedAt`) so:
 *   1. Self is never returned.
 *   2. If two dispatches both have rows, the deterministic older-wins
 *      tiebreaker `(started_at, id)` ensures both agree on which is "first."
 *      The newer dispatch sees the older row and aborts; the older dispatch
 *      sees nothing.
 *
 * `self.excludeRunIds` (#2121 Phase 2) additionally excludes the caller's
 * ancestor run-id chain: a `workflow:` sub-run shares its parent's checkout, so
 * the parent's own running/paused row must not count as a lock against the child.
 *
 * Returns the holding row, or null if the path is free.
 */
export async function getActiveWorkflowRunByPath(
  workingPath: string,
  self?: { id: string; startedAt: Date; excludeRunIds?: string[] }
): Promise<WorkflowRun | null> {
  const isPostgres = getDatabaseType() === 'postgresql';
  // Build params + clauses dynamically. Self exclusion + tiebreaker travel
  // together — the tiebreaker references both ids and timestamps.
  const params: unknown[] = [workingPath];
  const clauses: string[] = ['working_path = $1', activeWorkflowPathHolderCondition()];
  let selfIdParam: string | undefined;
  if (self !== undefined) {
    params.push(self.id);
    // Captured at push time — the tiebreaker below must reference THIS
    // placeholder, and excludeRunIds params may land in between.
    selfIdParam = `$${String(params.length)}`;
    clauses.push(`id != ${selfIdParam}`);
  }
  // Exclude the caller's ancestor chain (#2121 Phase 2): a `workflow:` sub-run
  // shares the parent's checkout, so the parent's own running/paused row on this
  // path must NOT count as a lock against the child. Each id is a separate
  // placeholder so both dialects bind positionally (no array binding).
  if (self?.excludeRunIds && self.excludeRunIds.length > 0) {
    const placeholders = self.excludeRunIds.map(id => {
      params.push(id);
      return `$${String(params.length)}`;
    });
    clauses.push(`id NOT IN (${placeholders.join(', ')})`);
  }
  if (self !== undefined) {
    // Older-wins tiebreaker. (started_at, id) is a total order so both
    // dispatches always agree on which is "first." Without this, two rows
    // with similar timestamps could mutually see each other and both abort.
    //
    // Serialize Date to ISO string — bun:sqlite rejects Date bindings.
    //
    // Format-aware comparison:
    //   PostgreSQL: started_at is TIMESTAMPTZ; cast the ISO param to
    //     timestamptz so the comparison is chronological, not lexical.
    //   SQLite: started_at is TEXT in "YYYY-MM-DD HH:MM:SS" format. Our
    //     ISO param has "YYYY-MM-DDTHH:MM:SS.mmmZ". Lexical comparison is
    //     WRONG: char 11 is space (0x20) in the column vs T (0x54) in the
    //     param, so every column value lex-sorts before every ISO param —
    //     making `started_at < $param` always TRUE regardless of actual
    //     time. Wrap both sides in datetime() to force chronological
    //     comparison via SQLite's date/time functions.
    params.push(self.startedAt.toISOString());
    const startedAtParam = `$${String(params.length)}`;
    // NOT params.length - 1: excludeRunIds placeholders may sit between the self
    // id and startedAt — a positional back-reference here once pointed the id
    // tiebreak at an ancestor id instead of self (caught by the SQL-shape test).
    // selfIdParam is always set when `self` is (same guard above).
    const idParam = selfIdParam ?? '$2';
    const colExpr = isPostgres ? 'started_at' : 'datetime(started_at)';
    const paramExpr = isPostgres ? `${startedAtParam}::timestamptz` : `datetime(${startedAtParam})`;
    clauses.push(`(${colExpr} < ${paramExpr} OR (${colExpr} = ${paramExpr} AND id < ${idParam}))`);
  }

  try {
    const result = await pool.query<WorkflowRunRow>(
      `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs
       WHERE ${clauses.join(' AND ')}
       ORDER BY started_at ASC, id ASC LIMIT 1`,
      params
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workingPath }, 'db.workflow_run_get_active_by_path_failed');
    throw new Error(`Failed to get active workflow run by path: ${err.message}`);
  }
}

/**
 * Find every run spawned as a child of `parentRunId` (#2121 Phase 2), oldest
 * first. Callers filter further by `metadata.parent_node_id` (a parent may have
 * several `workflow:` nodes) or by status (the abandon cascade cancels
 * non-terminal children).
 */
export async function findChildRuns(parentRunId: string): Promise<WorkflowRun[]> {
  try {
    const result = await pool.query<WorkflowRunRow>(
      'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE parent_run_id = $1 ORDER BY started_at ASC',
      [parentRunId]
    );
    return result.rows.map(row => normalizeWorkflowRun(row));
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, parentRunId }, 'db.workflow_run_find_children_failed');
    throw new Error(`Failed to find child workflow runs: ${err.message}`);
  }
}

/**
 * Safety cap on the `parent_run_id` walk. The load-time and runtime cycle guards
 * prevent creating a cyclic run tree, but a hand-edited DB must never hang the
 * walk — deeper than the runtime depth cap (5) so a legitimately deep-but-bounded
 * tree still resolves fully.
 */
const MAX_RUN_ANCESTRY_DEPTH = 32;

/**
 * Walk `parent_run_id` from `runId` up to the root, returning ancestors nearest
 * first (the immediate parent at index 0). Depth-capped and cycle-safe (a
 * repeated id stops the walk). Used by the runtime cycle guard and to build the
 * path-lock exclusion set for a shared-checkout sub-run.
 */
export async function getRunAncestry(runId: string): Promise<WorkflowRun[]> {
  const ancestors: WorkflowRun[] = [];
  const seen = new Set<string>([runId]);
  let current = await getWorkflowRun(runId);
  let depth = 0;
  while (current?.parent_run_id && depth < MAX_RUN_ANCESTRY_DEPTH) {
    const parentId = current.parent_run_id;
    if (seen.has(parentId)) break; // cyclic data — stop rather than loop forever
    const parent = await getWorkflowRun(parentId);
    if (!parent) break; // parent deleted (ON DELETE SET NULL orphan) — chain ends
    ancestors.push(parent);
    seen.add(parentId);
    current = parent;
    depth++;
  }
  return ancestors;
}

/**
 * Whether a run executes in this conversation as its own transcript: a hidden
 * worker conversation, or a CLI run's conversation. A foreground run started from
 * a chat executes in that chat (`conversation_id = parent_conversation_id`), and
 * the chat stays its owner's, so it does not count.
 */
export async function isRunTranscriptConversation(conversationId: string): Promise<boolean> {
  const result = await pool.query<{ found: number }>(
    `SELECT 1 AS found FROM remote_agent_workflow_runs
     WHERE conversation_id = $1
       AND (parent_conversation_id IS NULL OR parent_conversation_id <> conversation_id)
     LIMIT 1`,
    [conversationId]
  );
  return result.rows.length > 0;
}

/**
 * Find the most recent workflow run for a worker platform conversation ID.
 * Joins with conversations table to resolve platform_conversation_id → DB id.
 */
export async function getWorkflowRunByWorkerPlatformId(
  platformConversationId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRunRow>(
      `SELECT r.*, CAST(r.origin AS TEXT) AS origin FROM remote_agent_workflow_runs r
       JOIN remote_agent_conversations c ON r.conversation_id = c.id
       WHERE c.platform_conversation_id = $1 AND ${notOriginAnchor('c.id')}
       ORDER BY r.started_at DESC LIMIT 1`,
      [platformConversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_by_worker_platform_id_failed');
    throw new Error(`Failed to get workflow run by worker platform ID: ${err.message}`);
  }
}

export async function listConversationDetachBlockers(
  query: TransactionQuery,
  conversationId: string
): Promise<readonly Pick<WorkflowRun, 'id' | 'status'>[]> {
  const result = await query<Pick<WorkflowRun, 'id' | 'status'>>(
    `SELECT id, status FROM remote_agent_workflow_runs
     WHERE (conversation_id = $1 OR parent_conversation_id = $1)
       AND (status NOT IN (${TERMINAL_WORKFLOW_STATUSES.map(status => `'${status}'`).join(', ')})
            OR status IN (${RESUMABLE_WORKFLOW_STATUSES.map(status => `'${status}'`).join(', ')}))
     ORDER BY id`,
    [conversationId]
  );
  return result.rows;
}
