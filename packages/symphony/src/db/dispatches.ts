/**
 * Symphony dispatches: typed CRUD for the symphony_dispatches table.
 *
 * Each row records one (tracker, issue) → Archon workflow-run dispatch attempt.
 * The orchestrator (Phase 2) keys its in-memory state on `dispatch_key` so the
 * same raw issue id from two trackers (e.g. Linear + GitHub) cannot collide.
 *
 * Functions accept the `IDatabase` handle explicitly rather than reaching for
 * the `pool` singleton. Phase 2 will use `getDatabase()` from `@archon/core/db`
 * at call sites; tests pass a freshly-constructed `SqliteAdapter` against a
 * temp file (see ./dispatches.test.ts).
 */
import type { IDatabase } from '@archon/core/db';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('symphony.dispatches');
  return cachedLog;
}

export type DispatchTracker = 'linear' | 'github';
export type DispatchStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DispatchRow {
  id: string;
  issue_id: string;
  identifier: string;
  tracker: DispatchTracker;
  dispatch_key: string;
  codebase_id: string | null;
  workflow_name: string;
  workflow_run_id: string | null;
  attempt: number;
  dispatched_at: string;
  status: DispatchStatus;
  last_error: string | null;
}

export interface InsertDispatchInput {
  issue_id: string;
  identifier: string;
  tracker: DispatchTracker;
  dispatch_key: string;
  codebase_id?: string | null;
  workflow_name: string;
  workflow_run_id?: string | null;
  attempt: number;
  status: DispatchStatus;
  last_error?: string | null;
}

export async function insertDispatch(
  db: IDatabase,
  input: InsertDispatchInput
): Promise<DispatchRow> {
  const result = await db.query<DispatchRow>(
    `INSERT INTO symphony_dispatches
       (issue_id, identifier, tracker, dispatch_key, codebase_id, workflow_name,
        workflow_run_id, attempt, status, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.issue_id,
      input.identifier,
      input.tracker,
      input.dispatch_key,
      input.codebase_id ?? null,
      input.workflow_name,
      input.workflow_run_id ?? null,
      input.attempt,
      input.status,
      input.last_error ?? null,
    ]
  );
  if (!result.rows[0]) {
    throw new Error('insertDispatch: INSERT succeeded but no row returned');
  }
  return result.rows[0];
}

export async function getDispatchByDispatchKey(
  db: IDatabase,
  dispatchKey: string
): Promise<DispatchRow | null> {
  const result = await db.query<DispatchRow>(
    'SELECT * FROM symphony_dispatches WHERE dispatch_key = $1',
    [dispatchKey]
  );
  return result.rows[0] ?? null;
}

export async function getDispatchById(db: IDatabase, id: string): Promise<DispatchRow | null> {
  const result = await db.query<DispatchRow>('SELECT * FROM symphony_dispatches WHERE id = $1', [
    id,
  ]);
  return result.rows[0] ?? null;
}

export async function updateStatus(
  db: IDatabase,
  id: string,
  status: DispatchStatus,
  lastError?: string | null
): Promise<void> {
  await db.query('UPDATE symphony_dispatches SET status = $1, last_error = $2 WHERE id = $3', [
    status,
    lastError ?? null,
    id,
  ]);
}

export async function attachWorkflowRun(
  db: IDatabase,
  id: string,
  workflowRunId: string
): Promise<void> {
  const existing = await getDispatchById(db, id);
  if (!existing) {
    throw new Error(`attachWorkflowRun: dispatch ${id} not found`);
  }
  if (existing.workflow_run_id && existing.workflow_run_id !== workflowRunId) {
    getLog().warn(
      {
        dispatch_id: id,
        existing: existing.workflow_run_id,
        attempted: workflowRunId,
      },
      'symphony.attach_workflow_run_conflict'
    );
    throw new Error(
      `attachWorkflowRun: dispatch ${id} already attached to workflow_run ${existing.workflow_run_id}`
    );
  }
  await db.query('UPDATE symphony_dispatches SET workflow_run_id = $1 WHERE id = $2', [
    workflowRunId,
    id,
  ]);
}
