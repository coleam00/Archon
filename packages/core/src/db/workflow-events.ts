import { readProviderEventRows } from '@archon/workflows/provider-event-reader';
/**
 * Database operations for workflow events (lean UI-relevant events).
 *
 * Stores node lifecycle, parallel agent status, artifacts, errors, and every provider
 * event in the engine envelope (`provider_event`).
 *
 * Ordinary observability writes are fire-and-forget. Correctness-critical lifecycle
 * writes use `persistWorkflowEvent` and propagate storage failure to their owner.
 * Read operations also throw on error — callers own the degradation policy.
 */
import { pool, getDialect, getDatabaseType } from './connection';
import type { QueryResult } from './adapters/types';
import type { WorkflowEventRow } from '../schemas/workflow-event';
import { createLogger } from '@archon/paths';
import { foldDagResumeSnapshot } from '@archon/workflows/dag-resume-snapshot';
import {
  type ProviderEventQuery,
  type ProviderEventRecord,
} from '@archon/workflows/schemas/provider-event';
import { toHydratedTimestamp } from './timestamps';
import {
  PROVIDER_EVENT_ROW_TYPES,
  NODE_LIFECYCLE_EVENT_TYPES,
  foldActiveNodeIds,
  DURABLE_WORKFLOW_EVENT_TYPES,
  type DurableWorkflowEventType,
  type NodeLifecycleEventType,
  type DagResumeSnapshot,
  type WorkflowEventInput,
  type ObservabilityEventInput,
  type WorkflowEventType,
} from '@archon/workflows/store';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-events');
  return cachedLog;
}

export type { WorkflowEventRow } from '../schemas/workflow-event';

/**
 * Format a Date for a `created_at` comparison param to match how each dialect
 * STORES it. SQLite stores `datetime('now')` → "YYYY-MM-DD HH:MM:SS" as TEXT and
 * compares lexicographically, so the cursor MUST use that exact shape — an ISO
 * string ("…T…Z") sorts wrong (the space at index 10 is below 'T'), so
 * `created_at >= cursor` would silently match nothing. Postgres has a native
 * timestamptz and accepts the ISO string.
 */
function toDbDateParam(d: Date): string {
  return getDatabaseType() === 'sqlite'
    ? d.toISOString().replace('T', ' ').slice(0, 19) // "YYYY-MM-DD HH:MM:SS"
    : d.toISOString();
}

/**
 * Parse a row's `data` JSON defensively. A single malformed row must not abort a
 * whole batch — for the dashboard poller that would freeze the cursor and stop
 * all live updates (the same query keeps re-throwing). Bad data degrades to `{}`.
 */
function parseEventRow(row: WorkflowEventRow): WorkflowEventRow {
  if (typeof row.data !== 'string') return row;
  try {
    return { ...row, data: JSON.parse(row.data) as Record<string, unknown> };
  } catch (err) {
    getLog().warn(
      { err: err as Error, eventId: row.id, runId: row.workflow_run_id },
      'db.workflow_event_data_parse_failed'
    );
    return { ...row, data: {} };
  }
}

export type { WorkflowEventInput } from '@archon/workflows/store';

/**
 * A query function scoped to a specific connection — either the module-level
 * `pool` or a transaction-scoped query from `IDatabase.withTransaction`. The row
 * type is unused (INSERT returns none), so it is fixed to `unknown` rather than
 * generic, which lets a generic transaction query be passed directly.
 */
type EventInsertQuery = (sql: string, params?: unknown[]) => Promise<QueryResult<unknown>>;

/**
 * Insert one workflow-event row via `query` and THROW on failure. This is the
 * single source of truth for the event columns and dialect UUID; the
 * fire-and-forget createWorkflowEvent wraps it in try/catch, while callers that
 * need the write to be atomic with another mutation (the approval-gate CAS in
 * db/workflows.ts, #2146) pass a transaction-scoped query so a failed event
 * write rolls back the enclosing UPDATE instead of stranding a resolved gate
 * with no audit trail.
 */
export async function insertWorkflowEvent(
  query: EventInsertQuery,
  data: WorkflowEventInput
): Promise<void> {
  const dialect = getDialect();
  const id = dialect.generateUuid();
  await query(
    `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, step_index, step_name, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      data.workflow_run_id,
      data.event_type,
      data.step_index ?? null,
      data.step_name ?? null,
      JSON.stringify(data.data ?? {}),
    ]
  );
}

/**
 * Create a workflow event. Fire-and-forget - never throws.
 */
export async function createWorkflowEvent(data: ObservabilityEventInput): Promise<void> {
  try {
    await insertWorkflowEvent((sql, params) => pool.query(sql, params), data);
  } catch (error) {
    getLog().error(
      {
        err: error as Error,
        eventType: data.event_type,
        runId: data.workflow_run_id,
        stepName: data.step_name,
        // A lost provider event leaves a hole in its attempt's `seq`; name it.
        ...(data.event_type === 'provider_event'
          ? { attemptId: data.data?.attemptId, seq: data.data?.seq }
          : {}),
      },
      'db.workflow_event_create_failed'
    );
    // Fire-and-forget: never throw
  }
}

/** Persist a correctness-critical event and propagate storage errors to the caller. */
export async function persistWorkflowEvent(data: WorkflowEventInput): Promise<void> {
  await insertWorkflowEvent((sql, params) => pool.query(sql, params), data);
}

/**
 * Persist a correctness-critical start while the owning run is running, or while it is
 * paused when the caller already owns deterministic work that must finish through that
 * pause. This is one conditional INSERT rather than a SELECT followed by an INSERT: on
 * SQLite, a plain cancellation query can otherwise join the claim's open transaction
 * between those two statements. PostgreSQL additionally locks the selected run row, so
 * its concurrent cancellation UPDATE observes the same claim order.
 */
export async function persistWorkflowEventIfRunning(
  data: WorkflowEventInput,
  options?: { allowPaused?: boolean }
): Promise<{ persisted: boolean }> {
  const lockClause = getDatabaseType() === 'postgresql' ? ' FOR UPDATE' : '';
  const statusPredicate =
    options?.allowPaused === true ? "status IN ('running', 'paused')" : "status = 'running'";
  const result = await pool.query(
    `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, step_index, step_name, data)
     SELECT $1, $2, $3, $4, $5, $6
     FROM remote_agent_workflow_runs
     WHERE id = $2 AND ${statusPredicate}${lockClause}`,
    [
      getDialect().generateUuid(),
      data.workflow_run_id,
      data.event_type,
      data.step_index ?? null,
      data.step_name ?? null,
      JSON.stringify(data.data ?? {}),
    ]
  );
  return { persisted: result.rowCount > 0 };
}

/**
 * List all events for a workflow run in lifecycle order. `event_order` is
 * allocated by the database, so it preserves insertion order when timestamps tie.
 */
export async function listWorkflowEvents(
  workflowRunId: string,
  options: { excludeEventTypes?: readonly string[] } = {}
): Promise<WorkflowEventRow[]> {
  const excluded = options.excludeEventTypes ?? [];
  const excludeClause =
    excluded.length === 0
      ? ''
      : ` AND event_type NOT IN (${excluded.map((_, i) => `$${String(i + 2)}`).join(', ')})`;
  try {
    const result = await pool.query<WorkflowEventRow>(
      `SELECT * FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1${excludeClause}
       ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
      [workflowRunId, ...excluded]
    );
    return [...result.rows].map(row => ({
      ...row,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    }));
  } catch (error) {
    getLog().error({ err: error as Error, runId: workflowRunId }, 'db.workflow_events_list_failed');
    throw new Error(`Failed to list workflow events: ${(error as Error).message}`);
  }
}

/** Every row type `listProviderEvents` reads: the envelope and the rows it replaced. */
export { PROVIDER_EVENT_ROW_TYPES } from '@archon/workflows/store';

/**
 * A run's provider events as served (see `IWorkflowStore.listProviderEvents`). Records
 * come grouped by node, in the order each node first appears, and each node's in
 * emission order. A row that cannot be read is skipped and logged with its id, so one
 * bad row cannot blank a run.
 *
 * Rows written before the engine recorded envelopes translate with a null `attemptId`
 * and a `seq` counting that node's legacy rows from 0 in store order, and their
 * `observedAt` is the row's `created_at` (1-second precision on SQLite).
 */
export async function listProviderEvents(
  workflowRunId: string,
  query: ProviderEventQuery = {}
): Promise<ProviderEventRecord[]> {
  const params: unknown[] = [workflowRunId, ...PROVIDER_EVENT_ROW_TYPES];
  const typePlaceholders = PROVIDER_EVENT_ROW_TYPES.map((_, i) => `$${String(i + 2)}`).join(', ');
  let stepClause = '';
  if (query.stepName !== undefined) {
    params.push(query.stepName);
    stepClause = ` AND step_name = $${String(params.length)}`;
  }
  let rows: WorkflowEventRow[];
  try {
    const result = await pool.query<WorkflowEventRow>(
      `SELECT * FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type IN (${typePlaceholders})${stepClause}
       ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
      params
    );
    rows = result.rows.map(parseEventRow);
  } catch (error) {
    getLog().error({ err: error as Error, runId: workflowRunId }, 'db.provider_events_list_failed');
    throw new Error(`Failed to list provider events: ${(error as Error).message}`);
  }

  return readProviderEventRows(
    workflowRunId,
    rows.map(row => ({ ...row, created_at: toHydratedTimestamp(row.created_at).toISOString() })),
    query
  );
}

/**
 * List recent events for a workflow run since a given timestamp.
 */
export async function listRecentEvents(
  workflowRunId: string,
  since?: Date
): Promise<WorkflowEventRow[]> {
  try {
    if (since) {
      const result = await pool.query<WorkflowEventRow>(
        `SELECT * FROM remote_agent_workflow_events
         WHERE workflow_run_id = $1 AND created_at > $2
         ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
        [workflowRunId, toDbDateParam(since)]
      );
      return [...result.rows].map(row => ({
        ...row,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      }));
    }
    return await listWorkflowEvents(workflowRunId);
  } catch (error) {
    getLog().error(
      { err: error as Error, runId: workflowRunId },
      'db.workflow_events_list_recent_failed'
    );
    throw new Error(`Failed to list recent workflow events: ${(error as Error).message}`);
  }
}

/**
 * List workflow events across ALL runs created at or after `after`, oldest first,
 * capped at `limit`. Used by the dashboard event poller to tail events written by
 * any process (incl. out-of-process CLI runs) and replay them to the SSE dashboard.
 *
 * `>=` (not `>`) so events sharing the boundary timestamp are not skipped — SQLite's
 * `datetime('now')` is 1-second resolution, so ties are common; the caller dedupes by
 * id at the boundary and tolerates harmless duplicates (the dashboard reacts to events
 * by refetching, which is idempotent).
 *
 * `eventTypes` (when given) filters to those event types in SQL. The poller passes the
 * small set of dashboard-relevant types, which keeps high-frequency `tool_*` rows out of
 * the result — so a single 1-second bucket realistically never exceeds `limit`, and the
 * boundary `>=` + seen-set paging can't stall on overflow.
 */
export async function listWorkflowEventsSince(
  after: Date,
  limit: number,
  eventTypes?: readonly string[]
): Promise<WorkflowEventRow[]> {
  try {
    const params: unknown[] = [toDbDateParam(after)];
    let typeClause = '';
    if (eventTypes && eventTypes.length > 0) {
      const placeholders = eventTypes.map((_, i) => `$${String(i + 2)}`).join(', ');
      typeClause = ` AND event_type IN (${placeholders})`;
      params.push(...eventTypes);
    }
    params.push(limit);
    const limitParam = `$${String(params.length)}`;
    const result = await pool.query<WorkflowEventRow>(
      `SELECT * FROM remote_agent_workflow_events
       WHERE created_at >= $1${typeClause}
       ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC
       LIMIT ${limitParam}`,
      params
    );
    return [...result.rows].map(parseEventRow);
  } catch (error) {
    getLog().error({ err: error as Error }, 'db.workflow_events_list_since_failed');
    throw new Error(
      `Failed to list workflow events since ${after.toISOString()}: ${(error as Error).message}`
    );
  }
}

interface NodeLifecycleEvent {
  step_name: string | null;
  event_type: NodeLifecycleEventType;
}

interface NodeLifecycleEventRow extends NodeLifecycleEvent {
  workflow_run_id: string;
}

export async function listActiveWorkflowNodeIds(
  workflowRunIds: readonly string[]
): Promise<Map<string, string[]>> {
  if (workflowRunIds.length === 0) return new Map();

  const activeByRun = new Map(workflowRunIds.map(id => [id, new Set<string>()]));
  const runPlaceholders = workflowRunIds.map((_, index) => `$${String(index + 1)}`);
  const eventPlaceholders = NODE_LIFECYCLE_EVENT_TYPES.map(
    (_, index) => `$${String(workflowRunIds.length + index + 1)}`
  );
  const result = await pool.query<NodeLifecycleEventRow>(
    `SELECT workflow_run_id, step_name, event_type
     FROM remote_agent_workflow_events
     WHERE workflow_run_id IN (${runPlaceholders.join(', ')})
       AND event_type IN (${eventPlaceholders.join(', ')})
     ORDER BY workflow_run_id, created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
    [...workflowRunIds, ...NODE_LIFECYCLE_EVENT_TYPES]
  );

  for (const row of result.rows) {
    const activeNodeIds = activeByRun.get(row.workflow_run_id);
    if (activeNodeIds) foldActiveNodeIds(activeNodeIds, row.step_name, row.event_type);
  }

  return new Map([...activeByRun].map(([runId, activeNodeIds]) => [runId, [...activeNodeIds]]));
}

/**
 * Rows of the given event types, data included, for several runs in one query: each
 * run's rows in event order, and an entry (possibly empty) for every requested run. A
 * run list uses it to report per-node state without one query per run, fetching only the
 * types its fold reads so high-volume rows such as provider events never leave the
 * database.
 */
export async function listEventsForRuns(
  workflowRunIds: readonly string[],
  eventTypes: readonly WorkflowEventType[]
): Promise<Map<string, WorkflowEventRow[]>> {
  const byRun = new Map<string, WorkflowEventRow[]>(workflowRunIds.map(id => [id, []]));
  if (workflowRunIds.length === 0 || eventTypes.length === 0) return byRun;

  const runPlaceholders = workflowRunIds.map((_, index) => `$${String(index + 1)}`);
  const eventPlaceholders = eventTypes.map(
    (_, index) => `$${String(workflowRunIds.length + index + 1)}`
  );
  try {
    const result = await pool.query<WorkflowEventRow>(
      `SELECT * FROM remote_agent_workflow_events
       WHERE workflow_run_id IN (${runPlaceholders.join(', ')})
         AND event_type IN (${eventPlaceholders.join(', ')})
       ORDER BY workflow_run_id, created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
      [...workflowRunIds, ...eventTypes]
    );
    for (const row of result.rows) byRun.get(row.workflow_run_id)?.push(parseEventRow(row));
    return byRun;
  } catch (error) {
    getLog().error({ err: error as Error }, 'db.events_for_runs_list_failed');
    throw new Error(`Failed to list events for runs: ${(error as Error).message}`);
  }
}

export async function getDagResumeSnapshot(workflowRunId: string): Promise<DagResumeSnapshot> {
  const result = await pool.query<{
    step_name: string | null;
    event_type: DurableWorkflowEventType | 'fan_out_instances';
    data: string | Record<string, unknown>;
  }>(
    `SELECT step_name, event_type, data FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1 AND event_type IN (${DURABLE_WORKFLOW_EVENT_TYPES.map(
       (_, index) => `$${String(index + 2)}`
     ).join(', ')}, $${String(DURABLE_WORKFLOW_EVENT_TYPES.length + 2)})
     ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
    [workflowRunId, ...DURABLE_WORKFLOW_EVENT_TYPES, 'fan_out_instances']
  );
  return foldDagResumeSnapshot(result.rows, workflowRunId);
}
