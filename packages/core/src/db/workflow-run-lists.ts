/**
 * List and dashboard queries over workflow runs: the dashboard, the attention
 * queue's paused rows, filtered lists, the open-work inbox and the health check.
 * Re-exported from the `./workflows` entry.
 */
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import {
  isAttentionQueueRow,
  queuedRunAttention,
  TERMINAL_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import type {
  DashboardRunsResult,
  DashboardWorkflowRun,
  ListDashboardRunsOptions,
} from '../schemas/workflow-run';
import type { IDatabase } from './adapters/types';
import { getDatabaseType, getDialect, pool } from './connection';
import { listActiveWorkflowNodeIds } from './workflow-events';
import { notOriginAnchor } from './workflow-origin-anchor';
import {
  normalizeWorkflowRun,
  readWorkflowRunOrigin,
  type WorkflowRunRow,
} from './workflow-run-normalization';
import { getLog, jsonIntExtract } from './workflow-run-shared';

export async function getRunningWorkflows(): Promise<
  { id: string; conversation_id: string | null; workflow_name: string; started_at: string }[]
> {
  try {
    const result = await pool.query<{
      id: string;
      conversation_id: string | null;
      parent_conversation_id: string | null;
      user_id: string | null;
      origin: unknown;
      workflow_name: string;
      started_at: string;
    }>(
      "SELECT id, conversation_id, parent_conversation_id, user_id, CAST(origin AS TEXT) AS origin, workflow_name, started_at FROM remote_agent_workflow_runs WHERE status = 'running' ORDER BY started_at ASC LIMIT 100",
      []
    );
    return result.rows.map(row => ({
      id: row.id,
      workflow_name: row.workflow_name,
      started_at: row.started_at,
      conversation_id: readWorkflowRunOrigin(row)?.conversationId ?? null,
    }));
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_runs_get_running_failed');
    return []; // Non-critical: don't break health check
  }
}

function dashboardStatuses(
  status: NonNullable<ListDashboardRunsOptions['status']>
): WorkflowRunStatus[] {
  return [...new Set(Array.isArray(status) ? status : [status])];
}

/**
 * Build WHERE clauses shared between the list and count queries.
 * Returns the clauses array and values array (mutated in place).
 */
function buildDashboardWhereClauses(
  options: ListDashboardRunsOptions | undefined,
  values: unknown[]
): string[] {
  const whereClauses: string[] = [];

  if (options?.status) {
    const placeholders = dashboardStatuses(options.status).map(status => {
      values.push(status);
      return `$${String(values.length)}`;
    });
    whereClauses.push(`r.status IN (${placeholders.join(', ')})`);
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(`r.codebase_id = $${String(values.length)}`);
  }
  if (options?.parentRunIds !== undefined) {
    values.push(JSON.stringify(options.parentRunIds));
    const parameter = `$${String(values.length)}`;
    const parents =
      getDatabaseType() === 'postgresql'
        ? `SELECT value::uuid FROM json_array_elements_text(${parameter}::json) AS parents(value)`
        : `SELECT value FROM json_each(${parameter})`;
    whereClauses.push(`r.parent_run_id IN (${parents})`);
  }
  if (options?.excludeLeafStatuses?.length) {
    const placeholders = options.excludeLeafStatuses.map(status => {
      values.push(status);
      return `$${String(values.length)}`;
    });
    whereClauses.push(
      `(r.status NOT IN (${placeholders.join(', ')}) OR EXISTS (SELECT 1 FROM remote_agent_workflow_runs child WHERE child.parent_run_id = r.id))`
    );
  }
  if (options?.search) {
    const pattern = `%${options.search}%`;
    values.push(pattern, pattern);
    whereClauses.push(
      `(r.workflow_name LIKE $${String(values.length - 1)} OR r.user_message LIKE $${String(values.length)})`
    );
  }
  if (options?.after) {
    values.push(options.after);
    whereClauses.push(`r.started_at >= $${String(values.length)}`);
  }
  if (options?.before) {
    values.push(options.before);
    whereClauses.push(`r.started_at < $${String(values.length)}`);
  }

  return whereClauses;
}

type JoinedWorkflowRunRow = WorkflowRunRow &
  Pick<
    DashboardWorkflowRun,
    'codebase_name' | 'platform_type' | 'worker_platform_id' | 'parent_platform_id'
  >;

type DashboardRunRow = JoinedWorkflowRunRow & {
  // COUNT is BIGINT on PostgreSQL, which node-postgres returns as text.
  agents_completed: number | string | null;
  agents_failed: number | string | null;
  agents_total: number | string | null;
};

function toCount(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * List workflow runs with enriched JOINs for the dashboard Command Center.
 * Supports server-side search, status/date filtering, and offset-based pagination.
 * Returns runs, total matching count, and per-status counts for the filter bar.
 */
export async function listDashboardRuns(
  options?: ListDashboardRunsOptions
): Promise<DashboardRunsResult> {
  // Build shared WHERE for both queries
  const listValues: unknown[] = [];
  const whereClauses = buildDashboardWhereClauses(options, listValues);

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  listValues.push(limit);
  const limitParam = `$${String(listValues.length)}`;
  listValues.push(offset);
  const offsetParam = `$${String(listValues.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Build count query with the same base filters MINUS the status filter.
  // This lets us compute per-status counts across the full filtered set.
  const countValues: unknown[] = [];
  const countWhereClauses = buildDashboardWhereClauses(
    options ? { ...options, status: undefined } : undefined,
    countValues
  );
  const countWhereStr =
    countWhereClauses.length > 0 ? `WHERE ${countWhereClauses.join(' AND ')}` : '';

  try {
    const [listResult, countResult] = await Promise.all([
      pool.query<DashboardRunRow>(
        `SELECT r.*, CAST(r.origin AS TEXT) AS origin,
                c.platform_type,
                c.platform_conversation_id AS worker_platform_id,
                pc.platform_conversation_id AS parent_platform_id,
                cb.name AS codebase_name,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_completed') AS agents_completed,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_failed') AS agents_failed,
                (SELECT ${jsonIntExtract('e.data', 'totalAgents')}
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_started'
                 ORDER BY COALESCE(e.event_order, 0) DESC, e.created_at DESC, e.id DESC LIMIT 1) AS agents_total
         FROM remote_agent_workflow_runs r
         LEFT JOIN remote_agent_conversations c ON r.conversation_id = c.id AND ${notOriginAnchor('c.id')}
         LEFT JOIN remote_agent_conversations pc ON r.parent_conversation_id = pc.id
         LEFT JOIN remote_agent_codebases cb ON r.codebase_id = cb.id
         ${whereStr}
         ORDER BY r.started_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        listValues
      ),
      pool.query<{ status: string; cnt: string }>(
        `SELECT r.status, COUNT(*) AS cnt
         FROM remote_agent_workflow_runs r
         ${countWhereStr}
         GROUP BY r.status`,
        countValues
      ),
    ]);

    const counts = {
      all: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      pending: 0,
      paused: 0,
    };
    for (const row of countResult.rows) {
      const n = Number(row.cnt);
      counts.all += n;
      if (row.status in counts) {
        counts[row.status as keyof Omit<typeof counts, 'all'>] = n;
      }
    }

    // Total for the current filter (with status applied)
    const total = options?.status
      ? dashboardStatuses(options.status).reduce((sum, status) => sum + counts[status], 0)
      : counts.all;

    const activeByRun = await listActiveWorkflowNodeIds(listResult.rows.map(run => run.id));
    const runs = listResult.rows.map(run => {
      const activeNodes = activeByRun.get(run.id) ?? [];
      const hasSingleActiveNode = activeNodes.length === 1;
      return normalizeWorkflowRun({
        ...run,
        agents_completed: toCount(run.agents_completed),
        agents_failed: toCount(run.agents_failed),
        agents_total: toCount(run.agents_total),
        active_nodes: activeNodes,
        current_step_name: hasSingleActiveNode ? (activeNodes[0] ?? null) : null,
        current_step_status: hasSingleActiveNode ? ('running' as const) : null,
        total_steps: null,
      });
    });

    return { runs, total, counts };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'list_dashboard_runs_failed');
    throw new Error(`Failed to list dashboard runs: ${err.message}`);
  }
}

/** Paused runs that are attention queue items on their own (`queuedRunAttention`). */
export function listRunsNeedingAttention(
  query: IDatabase['query'] = pool.query
): Promise<DashboardWorkflowRun[]> {
  return listPausedRuns(query, run => queuedRunAttention(run) !== undefined);
}

/** The rows the attention queue reads (see `IWorkflowStore.listAttentionQueueRows`). */
export function listAttentionQueueRows(
  query: IDatabase['query'] = pool.query
): Promise<DashboardWorkflowRun[]> {
  return listPausedRuns(query, isAttentionQueueRow);
}

async function listPausedRuns(
  query: IDatabase['query'],
  keep: (run: DashboardWorkflowRun) => boolean
): Promise<DashboardWorkflowRun[]> {
  const result = await query<JoinedWorkflowRunRow>(
    `SELECT r.*, CAST(r.origin AS TEXT) AS origin,
            c.platform_type,
            c.platform_conversation_id AS worker_platform_id,
            pc.platform_conversation_id AS parent_platform_id,
            cb.name AS codebase_name
     FROM remote_agent_workflow_runs r
     LEFT JOIN remote_agent_conversations c ON r.conversation_id = c.id AND ${notOriginAnchor('c.id')}
     LEFT JOIN remote_agent_conversations pc ON r.parent_conversation_id = pc.id
     LEFT JOIN remote_agent_codebases cb ON r.codebase_id = cb.id
     WHERE r.status = 'paused'
     ORDER BY r.started_at DESC`
  );
  const runs: DashboardWorkflowRun[] = [];
  for (const row of result.rows) {
    let run: DashboardWorkflowRun;
    try {
      run = normalizeWorkflowRun({
        ...row,
        agents_completed: null,
        agents_failed: null,
        agents_total: null,
        active_nodes: [],
        current_step_name: null,
        current_step_status: null,
        total_steps: null,
      });
    } catch {
      // Parser errors can quote stored data, including message text.
      getLog().error({ workflowRunId: row.id }, 'attention_run_normalization_failed');
      continue;
    }
    if (keep(run)) runs.push(run);
  }
  return runs;
}

/**
 * List workflow runs with optional filters.
 */
export async function listWorkflowRuns(options?: {
  conversationId?: string;
  status?: WorkflowRunStatus | WorkflowRunStatus[];
  limit?: number;
  codebaseId?: string;
  /**
   * Non-enforcing "mine" filter: when set, restrict to runs attributed to this
   * user (`user_id = $N`). Absent → all runs (default visibility stays open).
   */
  userId?: string;
}): Promise<WorkflowRun[]> {
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  if (options?.conversationId) {
    values.push(options.conversationId);
    whereClauses.push(`conversation_id = $${String(values.length)}`);
  }
  if (options?.userId) {
    values.push(options.userId);
    whereClauses.push(`user_id = $${String(values.length)}`);
  }
  if (options?.status !== undefined) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    if (statuses.length > 0) {
      const startIdx = values.length + 1;
      values.push(...statuses);
      const placeholders = statuses.map((_, i) => `$${String(startIdx + i)}`).join(', ');
      whereClauses.push(`status IN (${placeholders})`);
    }
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(`remote_agent_workflow_runs.codebase_id = $${String(values.length)}`);
  }

  const limit = options?.limit ?? 50;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const result = await pool.query<WorkflowRunRow>(
      `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs ${whereStr} ORDER BY started_at DESC LIMIT ${limitParam}`,
      values
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_list_failed');
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }
}

/**
 * The open-work inbox (#2747): runs that ended with work on the table. Status-
 * derived v1 semantics — terminal AND failed AND no run has adopted or
 * superseded it (the NOT EXISTS closes the row behaviorally when a successor
 * claims it). Deletion is hard in this store, so "not deleted" holds by
 * construction. Paused/waiting/cancelled runs are excluded by design: they are
 * live or already judged.
 */
export async function findOpenWorkRuns(options?: {
  codebaseId?: string;
  limit?: number;
}): Promise<WorkflowRun[]> {
  const values: unknown[] = [];
  let codebaseClause = '';
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    codebaseClause = `AND codebase_id = $${String(values.length)}`;
  }
  const limit = options?.limit ?? 50;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;

  try {
    const result = await pool.query<WorkflowRunRow>(
      `SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs r
       WHERE r.status = 'failed'
         ${codebaseClause}
         AND NOT EXISTS (
           SELECT 1 FROM remote_agent_workflow_runs a
           WHERE a.adopted_from_run_id = r.id
         )
       ORDER BY r.started_at DESC
       LIMIT ${limitParam}`,
      values
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_open_work_list_failed');
    throw new Error(`Failed to list open workflow runs: ${err.message}`);
  }
}

/**
 * Runs that adopted or superseded `runId` (#2747) — the reverse direction of
 * `adopted_from_run_id`, same column, no second column. Newest first.
 */
export async function findAdoptingRuns(runId: string): Promise<WorkflowRun[]> {
  try {
    const result = await pool.query<WorkflowRunRow>(
      'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE adopted_from_run_id = $1 ORDER BY started_at DESC',
      [runId]
    );
    return result.rows.map(normalizeWorkflowRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'db.workflow_run_adopters_lookup_failed');
    throw new Error(`Failed to find adopting runs: ${err.message}`);
  }
}

export async function listNotifiedTerminalRuns(): Promise<WorkflowRun[]> {
  const field = (alias: string, key: string): string => getDialect().jsonText(`${alias}.data`, key);
  const baseline = field('e', 'baseline');
  const nonBaseline =
    getDatabaseType() === 'postgresql'
      ? `COALESCE(${baseline}, 'false') <> 'true'`
      : `COALESCE(${baseline}, 0) = 0`;
  const result = await pool.query<WorkflowRunRow>(
    `
    SELECT r.*, CAST(r.origin AS TEXT) AS origin FROM remote_agent_workflow_runs r
    WHERE r.status IN (${TERMINAL_WORKFLOW_STATUSES.map((_, i) => `$${String(i + 1)}`).join(', ')})
      AND EXISTS (SELECT 1 FROM remote_agent_workflow_events e
        WHERE e.workflow_run_id = r.id AND e.event_type = 'attention_notice_sent'
          AND ${nonBaseline} AND ${field('e', 'key')} <> 'terminal'
          AND NOT EXISTS (SELECT 1 FROM remote_agent_workflow_events t
            WHERE t.workflow_run_id = r.id AND t.event_type = 'attention_notice_sent'
              AND ${field('t', 'key')} = 'terminal'
              AND ${field('t', 'destination')} = ${field('e', 'destination')}))`,
    [...TERMINAL_WORKFLOW_STATUSES]
  );
  return result.rows.map(normalizeWorkflowRun);
}
