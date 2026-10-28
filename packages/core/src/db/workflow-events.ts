import { readProviderEventRows } from '@archon/workflows/provider-event-reader';
import { WORKFLOW_ORIGIN_ANCHOR_ID } from './workflow-origin-anchor';
import {
  attentionNoticeDataSchema,
  type AttentionNoticeData,
} from '@archon/workflows/schemas/attention-notice';
import type { IDatabase } from './adapters/types';
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
import { pool, getDialect } from './connection';
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
 * single source of truth for the event columns and dialect UUID; the autocommit
 * writers below queue it in run order, while callers that
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
    await persistWorkflowEvent(data);
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

/**
 * Tail of each run's pending autocommit event writes. On PostgreSQL each `pool.query`
 * can run on its own connection, so two writes issued back to back commit, and draw
 * `created_at` and `event_order`, in whichever order their backends finish. Chaining a
 * run's writes makes them commit in the order they were issued. The tail is taken when
 * the writer is called, not after an await, or the race moves into the queue.
 * Ordering holds within one process. Transactional `insertWorkflowEvent` callers
 * commit with their own mutation and do not join the chain.
 */
const runWriteTails = new Map<string, Promise<unknown>>();

function inRunOrder<T>(runId: string, write: () => Promise<T>): Promise<T> {
  const result = (runWriteTails.get(runId) ?? Promise.resolve()).then(write);
  const release = (): void => {
    if (runWriteTails.get(runId) === tail) runWriteTails.delete(runId);
  };
  // A failed write rejects its own caller but must not block the run's later writes.
  const tail = result.then(release, release);
  runWriteTails.set(runId, tail);
  return result;
}

/** Persist a correctness-critical event and propagate storage errors to the caller. */
export function persistWorkflowEvent(data: WorkflowEventInput): Promise<void> {
  return inRunOrder(data.workflow_run_id, () =>
    insertWorkflowEvent((sql, params) => pool.query(sql, params), data)
  );
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
  const statusPredicate =
    options?.allowPaused === true ? "status IN ('running', 'paused')" : "status = 'running'";
  const result = await inRunOrder(data.workflow_run_id, () =>
    pool.query(
      `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, step_index, step_name, data)
     SELECT $1, $2, $3, $4, $5, $6
     FROM remote_agent_workflow_runs
     WHERE id = $2 AND ${statusPredicate}${getDialect().rowLock()}`,
      [
        getDialect().generateUuid(),
        data.workflow_run_id,
        data.event_type,
        data.step_index ?? null,
        data.step_name ?? null,
        JSON.stringify(data.data ?? {}),
      ]
    )
  );
  return { persisted: result.rowCount > 0 };
}

/**
 * List all events for a workflow run in lifecycle order. `event_order` is
 * allocated by the database and takes precedence over timestamps. Legacy rows
 * without a sequence come first, ordered by timestamp then id.
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
       ORDER BY COALESCE(event_order, 0) ASC, created_at ASC, id ASC`,
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
       ORDER BY COALESCE(event_order, 0) ASC, created_at ASC, id ASC`,
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
     ORDER BY workflow_run_id, COALESCE(event_order, 0) ASC, created_at ASC, id ASC`,
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
 * run's rows in durable event order, and an entry (possibly empty) for every requested run.
 * Legacy rows without a sequence precede sequenced rows, ordered by timestamp then id. A
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
       ORDER BY workflow_run_id, COALESCE(event_order, 0) ASC, created_at ASC, id ASC`,
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
     ORDER BY COALESCE(event_order, 0) ASC, created_at ASC, id ASC`,
    [workflowRunId, ...DURABLE_WORKFLOW_EVENT_TYPES, 'fan_out_instances']
  );
  return foldDagResumeSnapshot(result.rows, workflowRunId);
}

export interface AttentionNoticeRecord {
  runId: string;
  data: AttentionNoticeData;
}

export async function listAttentionNotices(
  runIds: readonly string[],
  query: IDatabase['query'] = pool.query
): Promise<AttentionNoticeRecord[]> {
  if (runIds.length === 0) return [];
  const result = await query<WorkflowEventRow>(
    `SELECT * FROM remote_agent_workflow_events
    WHERE event_type = 'attention_notice_sent' AND workflow_run_id IN (${runIds.map((_, i) => `$${String(i + 1)}`).join(', ')})
    ORDER BY COALESCE(event_order, 0) ASC, created_at ASC, id ASC`,
    [...runIds]
  );
  return result.rows.map(row => ({
    runId: row.workflow_run_id,
    data: attentionNoticeDataSchema.parse(parseEventRow(row).data),
  }));
}

/**
 * Pauses whose inline chat notice the executor could not post, as `undeliveredNoticeKey`s.
 * Events from before the pause occurrence was recorded carry none and are not reported.
 */
export async function listUndeliveredPauseNotices(
  runIds: readonly string[],
  query: IDatabase['query'] = pool.query
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const result = await query<WorkflowEventRow>(
    `SELECT * FROM remote_agent_workflow_events
    WHERE event_type = 'pause_notice_undelivered' AND workflow_run_id IN (${runIds.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
    [...runIds]
  );
  const keys = new Set<string>();
  for (const row of result.rows) {
    const { occurrence } = parseEventRow(row).data;
    if (typeof occurrence === 'string')
      keys.add(undeliveredNoticeKey(row.workflow_run_id, occurrence));
  }
  return keys;
}

export function undeliveredNoticeKey(runId: string, occurrence: string): string {
  return `${runId}:${occurrence}`;
}

export async function hasAnyAttentionNotice(
  destination: string,
  query: IDatabase['query'] = pool.query
): Promise<boolean> {
  const extract = getDialect().jsonText('data', 'destination');
  const result = await query(
    `SELECT id FROM remote_agent_workflow_events WHERE event_type = 'attention_notice_sent' AND ${extract} = $1 LIMIT 1`,
    [destination]
  );
  return result.rows.length > 0;
}

export async function attentionConversationPlatforms(
  runIds: readonly string[],
  query: IDatabase['query'] = pool.query
): Promise<Map<string, string>> {
  if (runIds.length === 0) return new Map();
  const result = await query<{ run_id: string; platform_type: string }>(
    `
    WITH RECURSIVE ancestors AS (
      SELECT id AS run_id, id, parent_run_id, COALESCE(parent_conversation_id, NULLIF(conversation_id, '${WORKFLOW_ORIGIN_ANCHOR_ID}')) AS conversation_id
      FROM remote_agent_workflow_runs WHERE id IN (${runIds.map((_, i) => `$${String(i + 1)}`).join(', ')})
      UNION
      SELECT a.run_id, r.id, r.parent_run_id, COALESCE(r.parent_conversation_id, NULLIF(r.conversation_id, '${WORKFLOW_ORIGIN_ANCHOR_ID}'))
      FROM ancestors a JOIN remote_agent_workflow_runs r ON r.id = a.parent_run_id
      WHERE a.conversation_id IS NULL
    )
    SELECT a.run_id, c.platform_type FROM ancestors a
    JOIN remote_agent_conversations c ON c.id = a.conversation_id`,
    [...runIds]
  );
  return new Map(result.rows.map(row => [row.run_id, row.platform_type]));
}

export async function getWorkflowEventHead(): Promise<string> {
  const result = await pool.query<{ head: string | number | null }>(
    `SELECT MAX(head) AS head FROM (
       SELECT value AS head FROM remote_agent_workflow_event_sequence WHERE id = 1
       UNION ALL
       SELECT MAX(event_order) AS head FROM remote_agent_workflow_events
       UNION ALL
       SELECT MAX(event_order) AS head FROM remote_agent_workflow_event_archive
     ) committed`
  );
  const row = result.rows[0];
  if (row?.head == null) throw new Error('Workflow event head is missing');
  return String(row.head);
}

export async function readWorkflowEventsAfter(
  after: string,
  limit: number
): Promise<WorkflowEventRow[]> {
  const result = await pool.query<WorkflowEventRow>(
    `SELECT * FROM (
       SELECT * FROM remote_agent_workflow_events WHERE event_order > $1
       UNION ALL
       SELECT * FROM remote_agent_workflow_event_archive WHERE event_order > $1
     ) feed ORDER BY event_order LIMIT $2`,
    [after, limit]
  );
  return result.rows.map(parseEventRow);
}
