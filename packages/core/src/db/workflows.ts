/**
 * Database operations for workflow runs
 */
import { pool, getDialect, getDatabaseType } from './connection';
import type { IDatabase } from './adapters/types';
import type {
  WorkflowRun,
  WorkflowRunStatus,
  ApprovalContext,
  ApprovalResolution,
} from '@archon/workflows/schemas/workflow-run';
import {
  TERMINAL_WORKFLOW_STATUSES,
  getPausedApprovalContext,
  isLastApprovalContext,
} from '@archon/workflows/schemas/workflow-run';
import { createLogger } from '@archon/paths';

/** Best-effort ROLLBACK — log but swallow errors since we're already in an error path. */
function rollback(): Promise<void> {
  return pool.query('ROLLBACK', []).then(
    () => undefined,
    rollbackErr => {
      getLog().warn({ err: rollbackErr as Error }, 'db.rollback_failed');
    }
  );
}

/** Guard error for deleteWorkflowRun — re-thrown without wrapping in the outer catch. */
class WorkflowRunGuardError extends Error {}

/**
 * Normalize a WorkflowRun row from the database.
 * SQLite stores metadata as TEXT (JSON string), PostgreSQL returns parsed objects.
 * This ensures metadata is always a parsed object regardless of database backend.
 */
function normalizeWorkflowRun<T extends WorkflowRun>(row: T): T {
  if (typeof row.metadata === 'string') {
    try {
      row.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      row.metadata = {};
    }
  }
  return row;
}

function cloneWorkflowRunMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
}

interface ReplaceWorkflowRunMetadataOptions {
  status: WorkflowRunStatus;
  metadata: Record<string, unknown>;
  refreshStartedAt?: boolean;
  keepIncompleteFailure?: boolean;
}

async function selectWorkflowRunOrThrow(id: string): Promise<WorkflowRun> {
  let selectResult: Awaited<ReturnType<typeof pool.query<WorkflowRun>>>;
  try {
    selectResult = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_select_failed');
    throw new Error(`Failed to read workflow run: ${err.message}`);
  }

  const row = selectResult.rows[0];
  if (!row) {
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_select_not_found');
    throw new Error(`Workflow run not found (id: ${id})`);
  }

  return normalizeWorkflowRun(row);
}

async function replaceWorkflowRunMetadata(
  id: string,
  options: ReplaceWorkflowRunMetadataOptions
): Promise<WorkflowRun> {
  const dialect = getDialect();
  const setClauses = ['status = $1', 'metadata = $2'];
  const values: unknown[] = [options.status, JSON.stringify(options.metadata), id];

  if (options.status === 'running') {
    setClauses.push('completed_at = NULL');
  } else if (
    !(options.status === 'failed' && options.keepIncompleteFailure) &&
    TERMINAL_WORKFLOW_STATUSES.includes(options.status)
  ) {
    setClauses.push(`completed_at = ${dialect.now()}`);
  }

  if (options.refreshStartedAt) {
    setClauses.push(`started_at = ${dialect.now()}`);
  }

  setClauses.push(`last_activity_at = ${dialect.now()}`);

  let updateResult: Awaited<ReturnType<typeof pool.query>>;
  try {
    updateResult = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET ${setClauses.join(', ')}
       WHERE id = $3`,
      values
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_replace_metadata_failed');
    throw new Error(`Failed to update workflow run: ${err.message}`);
  }

  if (updateResult.rowCount === 0) {
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_replace_metadata_no_match');
    throw new Error(`Workflow run not found (id: ${id})`);
  }

  let selectResult: Awaited<ReturnType<typeof pool.query<WorkflowRun>>>;
  try {
    selectResult = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_replace_metadata_select_failed');
    throw new Error(`Failed to read workflow run after update: ${err.message}`);
  }

  const row = selectResult.rows[0];
  if (!row) {
    getLog().error({ workflowRunId: id }, 'db.workflow_run_replace_metadata_vanished');
    throw new Error(`Workflow run vanished after update (id: ${id})`);
  }

  return normalizeWorkflowRun(row);
}

export interface ResolveWorkflowRunApprovalOptions {
  status: 'failed' | 'completed' | 'cancelled';
  resolution: ApprovalResolution;
  metadata?: Record<string, unknown>;
  decisionText?: string;
}

export async function resolveWorkflowRunApproval(
  id: string,
  options: ResolveWorkflowRunApprovalOptions
): Promise<WorkflowRun> {
  const currentRun = await selectWorkflowRunOrThrow(id);
  const approval = getPausedApprovalContext(currentRun);
  if (!approval) {
    getLog().warn(
      { workflowRunId: id, status: currentRun.status },
      'db.workflow_run_resolve_no_approval'
    );
    throw new Error(`Workflow run is not paused with approval metadata (id: ${id})`);
  }

  const nextMetadata = cloneWorkflowRunMetadata(currentRun.metadata);
  delete nextMetadata.approval;
  nextMetadata.lastApproval = {
    ...approval,
    resolution: options.resolution,
    resolvedAt: new Date().toISOString(),
    ...(options.decisionText !== undefined ? { decisionText: options.decisionText } : {}),
  };
  if (options.metadata) {
    Object.assign(nextMetadata, options.metadata);
  }

  return replaceWorkflowRunMetadata(id, {
    status: options.status,
    metadata: nextMetadata,
    keepIncompleteFailure: options.status === 'failed',
  });
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflows');
  return cachedLog;
}

export async function createWorkflowRun(data: {
  workflow_name: string;
  conversation_id: string;
  codebase_id?: string;
  user_message: string;
  metadata?: Record<string, unknown>;
  working_path?: string;
  parent_conversation_id?: string;
}): Promise<WorkflowRun> {
  // Serialize metadata with validation to catch circular references early
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(data.metadata ?? {});
  } catch (serializeError) {
    const err = serializeError as Error;

    // Check if metadata contains critical context that must not be silently lost
    if (data.metadata && 'github_context' in data.metadata) {
      // Critical context (e.g., GitHub issue/PR details) must not be silently discarded.
      // Failing here surfaces the problem to the user instead of running the workflow
      // with empty context variables ($CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT).
      getLog().error(
        { err, metadataKeys: Object.keys(data.metadata) },
        'db.workflow_run_metadata_serialize_failed'
      );
      throw new Error(
        `Failed to serialize workflow metadata: ${err.message}. ` +
          'Metadata contains github_context which is required for this workflow.'
      );
    }

    // Non-critical metadata: fall back to empty object and log warning
    getLog().warn(
      { err, metadataKeys: data.metadata ? Object.keys(data.metadata) : [] },
      'db.workflow_run_metadata_serialize_fallback'
    );
    metadataJson = '{}';
  }

  try {
    const result = await pool.query<WorkflowRun>(
      `INSERT INTO remote_agent_workflow_runs
       (workflow_name, conversation_id, codebase_id, user_message, metadata, working_path, parent_conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.workflow_name,
        data.conversation_id,
        data.codebase_id ?? null,
        data.user_message,
        metadataJson,
        data.working_path ?? null,
        data.parent_conversation_id ?? null,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `Failed to create workflow run: INSERT returned no rows (workflow: ${data.workflow_name})`
      );
    }
    return normalizeWorkflowRun(row);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_create_failed');
    throw new Error(`Failed to create workflow run: ${err.message}`);
  }
}

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
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

export async function getWorkflowRunStatus(id: string): Promise<string | null> {
  try {
    const result = await pool.query<{ status: string }>(
      'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    return result.rows[0]?.status ?? null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_get_status_failed');
    throw new Error(`Failed to get workflow run status: ${err.message}`);
  }
}

export async function getActiveWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2) AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      [conversationId, conversationId]
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
 * Find a paused workflow run for a conversation (or its parent).
 * Used by the message handler to detect approval gates awaiting a natural-language response.
 * Non-throwing: returns null on DB error so the caller can fall through to normal routing.
 */
export async function getPausedWorkflowRun(conversationId: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE (conversation_id = $1 OR parent_conversation_id = $2) AND status = 'paused'
       ORDER BY started_at DESC LIMIT 1`,
      [conversationId, conversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, conversationId }, 'db.workflow_run_get_paused_failed');
    return null;
  }
}

/**
 * Find the workflow run currently holding the lock on `workingPath`.
 *
 * The lock is held by any row in `(running, paused)` or `pending` younger
 * than `STALE_PENDING_AGE_MS` (orphaned pre-creates beyond that window are
 * ignored — they're from crashed or resume-replaced dispatches).
 *
 * When called from a dispatch that already pre-created its own row, pass
 * `excludeId` and `selfStartedAt` so:
 *   1. Self is never returned.
 *   2. If two dispatches both have rows, the deterministic older-wins
 *      tiebreaker `(started_at, id)` ensures both agree on which is "first."
 *      The newer dispatch sees the older row and aborts; the older dispatch
 *      sees nothing.
 *
 * Returns the holding row, or null if the path is free.
 */
export const STALE_PENDING_AGE_MS = 5 * 60 * 1000; // 5 minutes

export async function getActiveWorkflowRunByPath(
  workingPath: string,
  self?: { id: string; startedAt: Date }
): Promise<WorkflowRun | null> {
  const isPostgres = getDatabaseType() === 'postgresql';
  const stalePendingCutoff = isPostgres
    ? `NOW() - INTERVAL '${String(STALE_PENDING_AGE_MS)} milliseconds'`
    : `datetime('now', '-${String(Math.floor(STALE_PENDING_AGE_MS / 1000))} seconds')`;

  // Build params + clauses dynamically. Self exclusion + tiebreaker travel
  // together — the tiebreaker references both ids and timestamps.
  const params: unknown[] = [workingPath];
  const clauses: string[] = [
    'working_path = $1',
    `(status IN ('running', 'paused') OR (status = 'pending' AND started_at > ${stalePendingCutoff}))`,
  ];
  if (self !== undefined) {
    params.push(self.id);
    clauses.push(`id != $${String(params.length)}`);
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
    const idParam = `$${String(params.length - 1)}`;
    const colExpr = isPostgres ? 'started_at' : 'datetime(started_at)';
    const paramExpr = isPostgres ? `${startedAtParam}::timestamptz` : `datetime(${startedAtParam})`;
    clauses.push(`(${colExpr} < ${paramExpr} OR (${colExpr} = ${paramExpr} AND id < ${idParam}))`);
  }

  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
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

export async function findLatestRunByWorkingPath(workingPath: string): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE working_path = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [workingPath]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workingPath }, 'db.workflow_run_find_latest_by_path_failed');
    throw new Error(`Failed to find latest workflow run by path: ${err.message}`);
  }
}

export async function getRunningWorkflows(): Promise<
  { id: string; conversation_id: string; workflow_name: string; started_at: string }[]
> {
  try {
    const result = await pool.query<{
      id: string;
      conversation_id: string;
      workflow_name: string;
      started_at: string;
    }>(
      "SELECT id, conversation_id, workflow_name, started_at FROM remote_agent_workflow_runs WHERE status = 'running' ORDER BY started_at ASC LIMIT 100",
      []
    );
    return [...result.rows];
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_runs_get_running_failed');
    return []; // Non-critical: don't break health check
  }
}

export async function findResumableRun(
  workflowName: string,
  workingPath: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND working_path = $2
         AND status = 'failed'
       ORDER BY started_at DESC
       LIMIT 1`,
      [workflowName, workingPath]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, errorType: err.constructor.name, workflowName, workingPath },
      'db.workflow_run_find_resumable_failed'
    );
    throw new Error(`Failed to find resumable run: ${err.message}`);
  }
}

/**
 * Find the most recent failed run for a workflow by parent conversation ID.
 * Used by the web orchestrator to detect approved runs that need foreground resume
 * (background dispatch would create a new worktree and lose the resumable run).
 */
export async function findResumableRunByParentConversation(
  workflowName: string,
  parentConversationId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs
       WHERE workflow_name = $1
         AND parent_conversation_id = $2
         AND status = 'failed'
       ORDER BY started_at DESC
       LIMIT 1`,
      [workflowName, parentConversationId]
    );
    const row = result.rows[0];
    return row ? normalizeWorkflowRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, workflowName, parentConversationId },
      'db.workflow_run_find_resumable_by_parent_failed'
    );
    throw new Error(`Failed to find resumable run by parent conversation: ${err.message}`);
  }
}

export async function resumeWorkflowRun(id: string): Promise<WorkflowRun> {
  const currentRun = await selectWorkflowRunOrThrow(id);
  const nextMetadata = cloneWorkflowRunMetadata(currentRun.metadata);
  delete nextMetadata.approval;

  if (isLastApprovalContext(nextMetadata.lastApproval)) {
    nextMetadata.lastApproval = {
      ...nextMetadata.lastApproval,
      resumedAt: new Date().toISOString(),
    };
  }

  // Refresh started_at to NOW so the resumed row competes fairly with
  // currently-active rows in getActiveWorkflowRunByPath's older-wins
  // tiebreaker. Without this, a resumed row carries its original
  // (potentially hours-old) started_at and would sort ahead of any
  // currently-running holder, slipping past the path lock and causing
  // two active workflows on the same working_path.
  //
  // We accept losing the original creation time here — `started_at` for
  // an active row semantically means "when did this active phase start."
  // The original creation time can be recovered from workflow_events
  // history if needed for analytics.
  try {
    return await replaceWorkflowRunMetadata(id, {
      status: 'running',
      metadata: nextMetadata,
      refreshStartedAt: true,
    });
  } catch (error) {
    const err = error as Error;
    if (
      err.message.startsWith('Workflow run not found') ||
      err.message.startsWith('Failed to read workflow run after update') ||
      err.message.startsWith('Workflow run vanished after update')
    ) {
      throw err;
    }
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_resume_failed');
    const message = err.message.startsWith('Failed to update workflow run: ')
      ? err.message.slice('Failed to update workflow run: '.length)
      : err.message;
    throw new Error(`Failed to resume workflow run: ${message}`);
  }
}

/**
 * Find the most recent workflow run for a worker platform conversation ID.
 * Joins with conversations table to resolve platform_conversation_id → DB id.
 */
export async function getWorkflowRunByWorkerPlatformId(
  platformConversationId: string
): Promise<WorkflowRun | null> {
  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT r.* FROM remote_agent_workflow_runs r
       JOIN remote_agent_conversations c ON r.conversation_id = c.id
       WHERE c.platform_conversation_id = $1
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

/**
 * Partially update a workflow run.
 * - Dynamically builds SQL from provided fields
 * - Auto-sets completed_at when status becomes 'completed' or 'failed'
 * - Merges metadata with existing (does not replace)
 * - No-op if updates object is empty
 */
export async function updateWorkflowRun(
  id: string,
  updates: Partial<Pick<WorkflowRun, 'status' | 'metadata'>>
): Promise<void> {
  const dialect = getDialect();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  // Helper to add parameterized clause
  function addParam(clause: string, value: unknown): void {
    values.push(value);
    setClauses.push(clause.replace('?', `$${values.length}`));
  }

  if (updates.status !== undefined) {
    addParam('status = ?', updates.status);
    // Auto-set completed_at for terminal-like statuses, but skip when
    // transitioning to 'failed' for approval resume (not a real completion)
    const isApprovalTransition =
      updates.status === 'failed' &&
      (updates.metadata?.approval_response !== undefined ||
        updates.metadata?.loop_user_input !== undefined ||
        updates.metadata?.loop_completion_input !== undefined);
    if (
      !isApprovalTransition &&
      (updates.status === 'completed' ||
        updates.status === 'failed' ||
        updates.status === 'cancelled')
    ) {
      setClauses.push(`completed_at = ${dialect.now()}`);
    }
  }
  if (updates.metadata !== undefined) {
    // Use dialect helper for JSON merge - need to calculate the param index
    const paramIndex = values.length + 1;
    values.push(JSON.stringify(updates.metadata));
    setClauses.push(`metadata = ${dialect.jsonMerge('metadata', paramIndex)}`);
  }
  if (updates.status !== undefined) {
    setClauses.push(`last_activity_at = ${dialect.now()}`);
  }

  if (setClauses.length === 0) return;

  values.push(id);
  const idParam = `$${values.length}`;

  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs SET ${setClauses.join(', ')} WHERE id = ${idParam}`,
      values
    );
    if (result.rowCount === 0) {
      getLog().warn({ workflowRunId: id }, 'db.workflow_run_update_no_match');
      throw new Error(`Workflow run not found (id: ${id})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_update_failed');
    throw new Error(`Failed to update workflow run: ${err.message}`);
  }
}

export async function completeWorkflowRun(
  id: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const dialect = getDialect();
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    if (metadata) {
      result = await pool.query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'completed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge('metadata', 2)}
         WHERE id = $1 AND status = 'running'`,
        [id, JSON.stringify(metadata)]
      );
    } else {
      result = await pool.query(
        `UPDATE remote_agent_workflow_runs
         SET status = 'completed', completed_at = ${dialect.now()}
         WHERE id = $1 AND status = 'running'`,
        [id]
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_complete_failed');
    throw new Error(`Failed to complete workflow run: ${err.message}`);
  }
  if (result.rowCount === 0) {
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_complete_no_match');
    throw new Error(`Workflow run not found or not in running state (id: ${id})`);
  }
}

export async function failWorkflowRun(
  id: string,
  error: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const dialect = getDialect();
  let result: Awaited<ReturnType<IDatabase['query']>>;
  try {
    result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'failed', completed_at = ${dialect.now()}, metadata = ${dialect.jsonMerge('metadata', 2)}
       WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify({ error, ...(metadata ?? {}) })]
    );
  } catch (dbError) {
    const err = dbError as Error;
    getLog().error({ err }, 'db.workflow_run_mark_failed_error');
    throw new Error(`Failed to fail workflow run: ${err.message}`);
  }
  if (result.rowCount === 0) {
    getLog().warn({ workflowRunId: id }, 'db.workflow_run_fail_no_match');
    throw new Error(`Workflow run not found or not in running state (id: ${id})`);
  }
}

export async function cancelWorkflowRun(id: string): Promise<void> {
  const dialect = getDialect();
  try {
    await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'cancelled', completed_at = ${dialect.now()}
       WHERE id = $1`,
      [id]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.workflow_run_cancel_failed');
    throw new Error(`Failed to cancel workflow run: ${err.message}`);
  }
}

/**
 * Pause a running workflow run for human approval.
 * Sets status to 'paused' and stores approval context in metadata.
 * Does NOT set completed_at — the run is not finished.
 */
export async function pauseWorkflowRun(
  id: string,
  approvalContext: ApprovalContext
): Promise<void> {
  const dialect = getDialect();
  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'paused',
           metadata = ${dialect.jsonMerge('metadata', 2)},
           last_activity_at = ${dialect.now()}
       WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify({ approval: approvalContext })]
    );
    if (result.rowCount === 0) {
      getLog().warn({ workflowRunId: id }, 'db.workflow_run_pause_no_match');
      throw new Error(`Workflow run not found or not in running state (id: ${id})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Workflow run not found')) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_pause_failed');
    throw new Error(`Failed to pause workflow run: ${err.message}`);
  }
}

/**
 * Enriched workflow run with joined data for the dashboard Command Center.
 */
export interface DashboardWorkflowRun extends WorkflowRun {
  codebase_name: string | null;
  platform_type: string | null;
  worker_platform_id: string | null;
  parent_platform_id: string | null;
  // Step-level progress (from latest step_started/step_completed event)
  current_step_name: string | null;
  total_steps: number | null;
  current_step_status: 'running' | 'completed' | 'failed' | null;
  // Parallel agent progress (from parallel_agent_* events)
  agents_completed: number | null;
  agents_failed: number | null;
  agents_total: number | null;
}

/** Options for listing dashboard runs with server-side search, filtering, and pagination. */
export interface ListDashboardRunsOptions {
  status?: WorkflowRunStatus;
  codebaseId?: string;
  search?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}

/** Response envelope for paginated dashboard runs. */
export interface DashboardRunsResult {
  runs: DashboardWorkflowRun[];
  total: number;
  counts: {
    all: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    pending: number;
    paused: number;
  };
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
    values.push(options.status);
    whereClauses.push(`r.status = $${String(values.length)}`);
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(`r.codebase_id = $${String(values.length)}`);
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

/**
 * Returns a SQL fragment to extract and cast an integer from a JSON data column.
 * Handles SQLite (`json_extract`) and PostgreSQL (`->>`/`::INTEGER`) dialects.
 */
function jsonIntExtract(col: string, key: string): string {
  return getDatabaseType() === 'postgresql'
    ? `(${col}->>'${key}')::INTEGER`
    : `CAST(json_extract(${col}, '$.${key}') AS INTEGER)`;
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
      pool.query<DashboardWorkflowRun>(
        `SELECT r.*,
                c.platform_type,
                c.platform_conversation_id AS worker_platform_id,
                pc.platform_conversation_id AS parent_platform_id,
                cb.name AS codebase_name,
                (SELECT e.step_name
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'step_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS current_step_name,
                (SELECT ${jsonIntExtract('e.data', 'total_steps')}
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'step_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS total_steps,
                CASE (SELECT e2.event_type
                      FROM remote_agent_workflow_events e2
                      WHERE e2.workflow_run_id = r.id
                        AND e2.event_type IN ('step_completed','step_failed','step_started')
                      ORDER BY e2.created_at DESC LIMIT 1)
                  WHEN 'step_completed' THEN 'completed'
                  WHEN 'step_failed' THEN 'failed'
                  WHEN 'step_started' THEN 'running'
                  ELSE NULL
                END AS current_step_status,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_completed') AS agents_completed,
                (SELECT COUNT(*) FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_failed') AS agents_failed,
                (SELECT ${jsonIntExtract('e.data', 'totalAgents')}
                 FROM remote_agent_workflow_events e
                 WHERE e.workflow_run_id = r.id AND e.event_type = 'parallel_agent_started'
                 ORDER BY e.created_at DESC LIMIT 1) AS agents_total
         FROM remote_agent_workflow_runs r
         LEFT JOIN remote_agent_conversations c ON r.conversation_id = c.id
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
      ? (counts[options.status as keyof typeof counts] ?? 0)
      : counts.all;

    return { runs: listResult.rows.map(normalizeWorkflowRun), total, counts };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'list_dashboard_runs_failed');
    throw new Error(`Failed to list dashboard runs: ${err.message}`);
  }
}

/**
 * List workflow runs with optional filters.
 */
export async function listWorkflowRuns(options?: {
  conversationId?: string;
  status?: WorkflowRunStatus | WorkflowRunStatus[];
  limit?: number;
  codebaseId?: string;
}): Promise<WorkflowRun[]> {
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  if (options?.conversationId) {
    values.push(options.conversationId);
    whereClauses.push(`conversation_id = $${String(values.length)}`);
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
    whereClauses.push(
      `conversation_id IN (SELECT id FROM remote_agent_conversations WHERE codebase_id = $${String(values.length)})`
    );
  }

  const limit = options?.limit ?? 50;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const result = await pool.query<WorkflowRun>(
      `SELECT * FROM remote_agent_workflow_runs ${whereStr} ORDER BY started_at DESC LIMIT ${limitParam}`,
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
 * Update parent_conversation_id on a workflow run.
 * Non-critical — logs error but does not throw.
 */
export async function updateWorkflowRunParent(
  runId: string,
  parentConversationId: string
): Promise<void> {
  try {
    await pool.query(
      'UPDATE remote_agent_workflow_runs SET parent_conversation_id = $1 WHERE id = $2',
      [parentConversationId, runId]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId, parentConversationId }, 'db.workflow_run_update_parent_failed');
    // Non-critical — don't throw
  }
}

/**
 * Update last_activity_at timestamp for a workflow run.
 * Used for activity-based staleness detection.
 * Throws on failure so callers can track consecutive failures.
 */
export async function updateWorkflowActivity(id: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_workflow_runs SET last_activity_at = ${dialect.now()} WHERE id = $1`,
    [id]
  );
}

/**
 * Transition all 'running' workflow runs to 'failed'.
 * Called on server startup to mark runs orphaned by process termination.
 * Excludes CLI-owned runs because they may still be executing in a separate
 * process while sharing the same database with the server.
 * The next invocation of the same workflow at the same path will auto-resume
 * from completed nodes via findResumableRun.
 */
export async function failOrphanedRuns(): Promise<{ count: number }> {
  const dialect = getDialect();
  try {
    const result = await pool.query(
      `UPDATE remote_agent_workflow_runs
       SET status = 'failed',
           completed_at = ${dialect.now()},
           metadata = ${dialect.jsonMerge('metadata', 1)}
       WHERE status = 'running'
         AND conversation_id IN (
           SELECT id FROM remote_agent_conversations WHERE platform_type != 'cli'
         )`,
      [JSON.stringify({ failure_reason: 'server_restart' })]
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      getLog().info({ count }, 'db.orphaned_workflow_runs_failed');
    }
    return { count };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.orphaned_workflow_runs_fail_failed');
    throw new Error(`Failed to fail orphaned workflow runs: ${err.message}`);
  }
}

/**
 * Delete terminal workflow runs older than the given number of days.
 * Returns the count of deleted runs.
 */
export async function deleteOldWorkflowRuns(olderThanDays: number): Promise<{ count: number }> {
  // Validate olderThanDays is a safe non-negative integer before SQL interpolation.
  // The dialect has no "date subtract" helper, so we must interpolate — but only after validation.
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
    throw new Error(
      `Invalid olderThanDays: ${String(olderThanDays)} (must be a non-negative integer)`
    );
  }
  const cutoff =
    getDatabaseType() === 'postgresql'
      ? `NOW() - INTERVAL '${String(olderThanDays)} days'`
      : `datetime('now', '-${String(olderThanDays)} days')`;
  try {
    await pool.query('BEGIN', []);
    // Delete events first (FK reference)
    await pool.query(
      `DELETE FROM remote_agent_workflow_events WHERE workflow_run_id IN (
        SELECT id FROM remote_agent_workflow_runs
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND started_at < ${cutoff}
      )`,
      []
    );
    const result = await pool.query(
      `DELETE FROM remote_agent_workflow_runs
       WHERE status IN ('completed', 'failed', 'cancelled')
         AND started_at < ${cutoff}`,
      []
    );
    await pool.query('COMMIT', []);
    return { count: result.rowCount ?? 0 };
  } catch (error) {
    await rollback();
    const err = error as Error;
    getLog().error({ err, olderThanDays }, 'db.workflow_runs_cleanup_failed');
    throw new Error(`Failed to clean up old workflow runs: ${err.message}`);
  }
}

/**
 * Delete a workflow run and its associated events.
 * Only terminal runs (completed, failed, cancelled) can be deleted.
 */
export async function deleteWorkflowRun(id: string): Promise<void> {
  try {
    await pool.query('BEGIN', []);
    // Guard: verify run exists and is terminal before deleting
    const check = await pool.query<{ status: string }>(
      'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      throw new WorkflowRunGuardError(`Workflow run not found: ${id}`);
    }
    if (!TERMINAL_WORKFLOW_STATUSES.includes(check.rows[0].status as WorkflowRunStatus)) {
      throw new WorkflowRunGuardError(
        `Cannot delete workflow run in '${check.rows[0].status}' status — cancel it first`
      );
    }
    await pool.query('DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = $1', [id]);
    await pool.query('DELETE FROM remote_agent_workflow_runs WHERE id = $1', [id]);
    await pool.query('COMMIT', []);
  } catch (error) {
    await rollback();
    if (error instanceof WorkflowRunGuardError) throw error;
    const err = error as Error;
    getLog().error({ err, workflowRunId: id }, 'db.workflow_run_delete_failed');
    throw new Error(`Failed to delete workflow run: ${err.message}`);
  }
}
