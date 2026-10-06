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
import { mergeTokenUsage, type TokenUsage } from '@archon/providers/types';
import { readFile } from 'node:fs/promises';
import type { FanOutInstanceSnapshot } from '@archon/workflows/fan-out-identity';
import { nodeInvocationKey, readNodeRecordEvent } from '@archon/workflows/node-record-reader';
import { nodeCostScope } from '@archon/workflows/node-record-serialization';
import type { NodeExecutionMetadata } from '@archon/workflows/schemas/node-execution';
import {
  orderProviderEventRecords,
  providerEventEnvelopeSchema,
  providerEventRecordsAfter,
  type ProviderEventQuery,
  type ProviderEventRecord,
} from '@archon/workflows/schemas/provider-event';
import { providerEventSchema, type ProviderEvent } from '@archon/provider-contract';
import { toHydratedTimestamp } from './timestamps';
import {
  PROVIDER_EVENT_ROW_TYPES,
  NODE_LIFECYCLE_EVENT_TYPES,
  NODE_STATE_EVENT_TYPES,
  type NodeStateEventType,
  type NodeLifecycleEventType,
  type DagResumeSnapshot,
  type PersistedNodeOutput,
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

function dataString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

function dataNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' ? value : undefined;
}

const LEGACY_TOOL_STATUS: Record<string, 'completed' | 'failed' | 'cancelled'> = {
  success: 'completed',
  error: 'failed',
  interrupted: 'cancelled',
  unknown: 'cancelled',
};

const LEGACY_HOOK_STATUS: Record<string, 'succeeded' | 'failed' | 'cancelled'> = {
  success: 'succeeded',
  error: 'failed',
  cancelled: 'cancelled',
};

const LEGACY_SUBTASK_STATUS: Record<
  string,
  'started' | 'running' | 'completed' | 'failed' | 'stopped'
> = {
  started: 'started',
  progress: 'running',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};

/**
 * The provider event a pre-envelope row recorded, from the keys v0.11.0 wrote. The result
 * is parsed with the contract schema, so a row missing a required fact (a tool row with
 * no `tool_call_id`) yields nothing rather than a record the contract forbids.
 */
function translateLegacyRow(
  eventType: string,
  data: Record<string, unknown>
): ProviderEvent | undefined {
  let candidate: unknown;
  switch (eventType) {
    case 'tool_called':
      candidate = {
        type: 'tool_call',
        toolCallId: data.tool_call_id,
        name: data.tool_name,
        ...(data.tool_input !== undefined ? { rawInput: data.tool_input } : {}),
      };
      break;
    case 'tool_completed': {
      // A row with no outcome came from a reported tool result, before outcomes existed.
      const outcome = dataString(data, 'tool_outcome');
      const exitCode = dataNumber(data, 'exit_code');
      candidate = {
        type: 'tool_call_update',
        toolCallId: data.tool_call_id,
        status: outcome === undefined ? 'completed' : LEGACY_TOOL_STATUS[outcome],
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
      break;
    }
    case 'task_activity': {
      const activity = dataString(data, 'activity');
      candidate = {
        type: 'subtask',
        taskId: data.task_id,
        status: activity === undefined ? undefined : LEGACY_SUBTASK_STATUS[activity],
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.summary !== undefined ? { summary: data.summary } : {}),
        ...(data.task_type !== undefined ? { taskType: data.task_type } : {}),
        ...(data.last_tool_name !== undefined ? { lastToolName: data.last_tool_name } : {}),
        ...(data.output_file !== undefined ? { outputFile: data.output_file } : {}),
        ...(data.usage !== undefined ? { usage: data.usage } : {}),
      };
      break;
    }
    case 'hook_activity': {
      const outcome = dataString(data, 'outcome');
      const exitCode = dataNumber(data, 'exit_code');
      candidate = {
        type: 'hook',
        hookId: data.hook_id,
        hookName: data.hook_name,
        hookEvent: data.hook_event,
        status:
          dataString(data, 'activity') === 'started'
            ? 'started'
            : outcome === undefined
              ? undefined
              : LEGACY_HOOK_STATUS[outcome],
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
      break;
    }
    default:
      return undefined;
  }
  const parsed = providerEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

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

  const byStep = new Map<string, ProviderEventRecord[]>();
  const legacySeq = new Map<string, number>();
  for (const row of rows) {
    const stepName = row.step_name;
    let record: ProviderEventRecord | undefined;
    if (stepName !== null && row.event_type === 'provider_event') {
      const envelope = providerEventEnvelopeSchema.safeParse(row.data);
      if (envelope.success) record = { runId: workflowRunId, stepName, ...envelope.data };
    } else if (stepName !== null) {
      const event = translateLegacyRow(row.event_type, row.data);
      if (event !== undefined) {
        const seq = legacySeq.get(stepName) ?? 0;
        legacySeq.set(stepName, seq + 1);
        record = {
          runId: workflowRunId,
          stepName,
          attemptId: null,
          seq,
          observedAt: toHydratedTimestamp(row.created_at).toISOString(),
          event,
        };
      }
    }
    if (record === undefined) {
      getLog().warn(
        { eventId: row.id, runId: workflowRunId, eventType: row.event_type },
        'db.provider_event_row_unreadable'
      );
      continue;
    }
    const stepRecords = byStep.get(record.stepName) ?? [];
    stepRecords.push(record);
    byStep.set(record.stepName, stepRecords);
  }

  const ordered = [...byStep.values()].flatMap(records => orderProviderEventRecords(records));
  return query.after === undefined ? ordered : providerEventRecordsAfter(ordered, query.after);
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

/**
 * Return completed node outputs and cumulative usage (tokens AND cost) for a workflow
 * run. Used by the DAG executor to restore state when resuming a failed run.
 * Throws on DB error — caller owns the degradation policy.
 *
 * Both usage axes are summed from `node_completed` and `node_failed` rows, and only
 * from rows whose `nodeCostScope` is their own spend. Failed rows contribute spend but
 * never completed outputs, so their nodes remain eligible for resume.
 *
 * This makes a run's total MONEY BURNED, not the cost of the surviving path — the
 * figure an operator watching a budget wants, and a deliberate change from what the
 * number meant before failed rows were summed (#2654). Three consequences follow, all
 * intended:
 *
 * - The same node's first and second attempt both count. A node that failed at $0.02
 *   and succeeded at $0.03 on resume contributes $0.05, because both rows are real
 *   spend.
 * - `retry:` counts every attempt, for the same reason — `runNodeRetryLoop` writes one
 *   event per attempt.
 * - An `always_run` node re-executes on every resume pass and its spend accrues each
 *   time.
 *
 * A resumed run's total therefore exceeds what the surviving path cost, and grows with
 * each resume. That is the point; it is not double counting, which is what the two
 * exclusions below prevent.
 *
 * Cache axes sum over the rows that reported them and carry `cachePartial` when any row
 * did not, so a pre-#2654 row narrows the cache total instead of erasing it. Two
 * distinct duplication hazards:
 *
 * - `node_skipped_prior_success` rows replay a node an earlier pass already counted, so
 *   counting them would multiply that node's usage by the number of resume passes.
 * - `total`-scope rows are derived from other rows already in this log — a
 *   `loop_group`'s roll-up restates the `cost_usd` its own `<groupId>.<nodeId>` body rows
 *   carry, so summing both counts that group twice (#2469).
 *
 * Rows written before the `aggregate` marker existed carry no flag, so a run that
 * completed a loop_group under an older build and is resumed under this one can still
 * double-count its cost. Bounded and self-clearing: only cost is affected (the roll-up
 * never carried `tokens`), and only until those runs reach a terminal state.
 */
function isFanOutItem(value: unknown): value is FanOutInstanceSnapshot['item'] {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isFanOutItem);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(isFanOutItem);
}

function isFanOutInputs(value: unknown): value is Record<string, FanOutInstanceSnapshot['item']> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isFanOutItem)
  );
}

function parseFanOutSnapshots(value: unknown): FanOutInstanceSnapshot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const identities = new Set<string>();
  const snapshots: FanOutInstanceSnapshot[] = [];
  for (const [index, entry] of value.entries()) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('ordinal' in entry) ||
      !('identity' in entry) ||
      !('item' in entry) ||
      !('inputs' in entry) ||
      entry.ordinal !== index ||
      typeof entry.identity !== 'string' ||
      entry.identity.length === 0 ||
      identities.has(entry.identity) ||
      !isFanOutItem(entry.item) ||
      !isFanOutInputs(entry.inputs)
    ) {
      return undefined;
    }
    identities.add(entry.identity);
    snapshots.push({
      ordinal: index,
      identity: entry.identity,
      item: entry.item,
      inputs: entry.inputs,
    });
  }
  return snapshots;
}

interface NodeLifecycleEvent {
  step_name: string | null;
  event_type: NodeLifecycleEventType;
}

interface NodeLifecycleEventRow extends NodeLifecycleEvent {
  workflow_run_id: string;
}

function foldActiveNodeIds(
  activeNodeIds: Set<string>,
  stepName: string | null,
  eventType: NodeStateEventType
): void {
  if (!stepName) return;
  if (eventType === 'node_started' || eventType === 'node_suspended') {
    activeNodeIds.add(stepName);
  } else {
    activeNodeIds.delete(stepName);
  }
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
  if (workflowRunIds.length === 0) return byRun;

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
    event_type: NodeStateEventType | 'fan_out_instances';
    data: string | Record<string, unknown>;
  }>(
    `SELECT step_name, event_type, data FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1 AND event_type IN (${NODE_STATE_EVENT_TYPES.map(
       (_, index) => `$${String(index + 2)}`
     ).join(', ')}, $${String(NODE_STATE_EVENT_TYPES.length + 2)})
     ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
    [workflowRunId, ...NODE_STATE_EVENT_TYPES, 'fan_out_instances']
  );
  const completedNodeOutputs = new Map<string, PersistedNodeOutput>();
  const fanOutSnapshots = new Map<string, readonly FanOutInstanceSnapshot[]>();
  const unresolvedNodeStarts = new Set<string>();
  const unfinishedInvocations = new Map<string, NodeExecutionMetadata>();
  // The completion a reusable output belongs to. A prior-success replay row carries no
  // execution facts of its own, so it inherits the completion it replays.
  const completedExecutions = new Map<string, NodeExecutionMetadata>();
  // Collected and merged once at the end rather than folded pairwise: a pairwise fold
  // cannot tell "one of five contributions reported" from "one of two" (#2662).
  const usageContributions: { stepName: string; tokens?: TokenUsage; costUsd?: number }[] = [];
  const authoritativeInstanceScopes = new Set<string>();
  for (const row of result.rows) {
    if (!row.step_name) continue;
    if (row.event_type !== 'fan_out_instances') {
      foldActiveNodeIds(unresolvedNodeStarts, row.step_name, row.event_type);
      // Every later node state supersedes reusable success, even when that row
      // carries no output (or its data cannot be recovered). Only success restores it.
      completedNodeOutputs.delete(row.step_name);
    }
    let rawData: Record<string, unknown>;
    let record: ReturnType<typeof readNodeRecordEvent>;
    try {
      rawData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch (parseErr) {
      getLog().warn(
        { err: parseErr as Error, runId: workflowRunId, stepName: row.step_name },
        'db.workflow_dag_node_output_parse_failed'
      );
      continue;
    }
    if (row.event_type === 'fan_out_instances') {
      if (!fanOutSnapshots.has(row.step_name)) {
        const snapshots = parseFanOutSnapshots(rawData.instances);
        if (snapshots !== undefined) fanOutSnapshots.set(row.step_name, snapshots);
      }
      continue;
    }
    try {
      record = readNodeRecordEvent({
        workflow_run_id: workflowRunId,
        step_name: row.step_name,
        event_type: row.event_type,
        data: rawData,
      });
    } catch (parseErr) {
      throw new Error(
        `Invalid node execution record for '${row.step_name}' in run ${workflowRunId}`,
        { cause: parseErr }
      );
    }
    if (!record) continue;
    const data = record.data;
    if (record.metadata) {
      const key = nodeInvocationKey(record.path, record.metadata.invocation.loopPath);
      if (
        record.eventType === 'node_started' ||
        record.eventType === 'node_suspended' ||
        record.eventType === 'node_failed'
      ) {
        unfinishedInvocations.set(key, record.metadata);
      } else if (record.eventType === 'node_completed' || record.eventType === 'node_skipped') {
        unfinishedInvocations.delete(key);
      }
      if (record.eventType === 'node_completed')
        completedExecutions.set(record.path, record.metadata);
      else completedExecutions.delete(record.path);
    } else if (
      record.eventType === 'node_skipped_prior_success' ||
      record.eventType === 'node_always_run_reset' ||
      record.eventType === 'node_prior_cache_invalidated'
    ) {
      for (const [key, metadata] of unfinishedInvocations)
        if (metadata.path === record.path) unfinishedInvocations.delete(key);
    }
    if (
      row.event_type !== 'node_completed' &&
      row.event_type !== 'node_skipped_prior_success' &&
      row.event_type !== 'node_failed'
    )
      continue;
    if (row.event_type !== 'node_failed' && typeof data.node_output === 'string') {
      // A bash/script node's persisted text is a bounded preview once it exceeded the
      // truncation cap; the full bytes were spilled to `node_output_spill_path` at write
      // time (#2726). Prefer the spill so a resumed run's `$node.output`/`.field` sees
      // exactly what a fresh run's in-process consumer would have. A missing/unreadable
      // spill retains the preview and its incompleteness rather than failing resume.
      // Prior-success replay must preserve that provenance for later terminal records.
      //
      // The spill file is addressed by a stable, node-scoped filename that a later
      // execution of the SAME node overwrites in place (by design — see
      // `formatPersistedNodeOutput`'s doc comment). The spill precedes its awaited
      // lifecycle insert, so a process crash between the file overwrite and that insert
      // can still leave an older, durable row pointing at
      // a NEWER execution's content. Guard against that by validating the file's actual
      // byte length against this row's own recorded `node_output_original_bytes` before
      // trusting it — a mismatch means the file no longer describes this row, so fall
      // back to the bounded preview exactly like a missing spill would.
      let output = data.node_output;
      let outputTruncation: PersistedNodeOutput['outputTruncation'] =
        data.node_output_truncated === true || typeof data.node_output_spill_path === 'string'
          ? {
              originalBytes:
                typeof data.node_output_original_bytes === 'number'
                  ? data.node_output_original_bytes
                  : null,
              spillPath:
                typeof data.node_output_spill_path === 'string'
                  ? data.node_output_spill_path
                  : null,
            }
          : undefined;
      if (typeof data.node_output_spill_path === 'string') {
        try {
          const spilled = await readFile(data.node_output_spill_path, 'utf8');
          const spilledBytes = Buffer.byteLength(spilled, 'utf8');
          if (
            typeof data.node_output_original_bytes === 'number' &&
            spilledBytes !== data.node_output_original_bytes
          ) {
            getLog().warn(
              {
                runId: workflowRunId,
                stepName: row.step_name,
                spillPath: data.node_output_spill_path,
                expectedBytes: data.node_output_original_bytes,
                actualBytes: spilledBytes,
              },
              'db.workflow_dag_node_output_spill_stale'
            );
          } else {
            output = spilled;
            outputTruncation = undefined;
          }
        } catch (spillErr) {
          getLog().warn(
            {
              err: spillErr as Error,
              runId: workflowRunId,
              stepName: row.step_name,
              spillPath: data.node_output_spill_path,
            },
            'db.workflow_dag_node_output_spill_read_failed'
          );
        }
      }
      completedNodeOutputs.set(row.step_name, {
        output,
        ...(outputTruncation !== undefined ? { outputTruncation } : {}),
        // The node's logical value (#2637), persisted beside its text by the emit
        // sites (and copied forward by node_skipped_prior_success re-emits). Absent
        // on pre-#2637 rows — the executor then falls back to text re-parsing.
        ...(data.structured_output !== undefined
          ? { structuredOutput: data.structured_output }
          : {}),
        // The persisted contract owns authorization on resume, especially for a child
        // result whose schema is not available in the parent's definition. The reader
        // already turned a legacy `declared_fields` row into depth-1 paths.
        ...(data.declared_output_paths !== undefined
          ? { declaredOutputPaths: data.declared_output_paths }
          : {}),
        ...(completedExecutions.has(row.step_name)
          ? { execution: completedExecutions.get(row.step_name) }
          : {}),
      });
    }
    // Composed-instance terminals are the durable accounting source for their whole
    // scope. Their inner rows are observability writes and may be missing after a crash.
    const isAuthoritativeInstanceUsage =
      data.type === 'compose_fan_out_instance' &&
      (row.event_type === 'node_completed' || row.event_type === 'node_failed');
    if (isAuthoritativeInstanceUsage) authoritativeInstanceScopes.add(row.step_name);
    // Other aggregate rows merely restate usage already carried by their leaves.
    if (nodeCostScope(data) === 'total' && !isAuthoritativeInstanceUsage) continue;
    const contribution: { stepName: string; tokens?: TokenUsage; costUsd?: number } = {
      stepName: row.step_name,
    };
    if (row.event_type !== 'node_skipped_prior_success' && record.rawUsage.tokens !== undefined) {
      const eventTokens = record.rawUsage.tokens;
      if (
        typeof eventTokens === 'object' &&
        eventTokens !== null &&
        'input' in eventTokens &&
        'output' in eventTokens &&
        typeof eventTokens.input === 'number' &&
        typeof eventTokens.output === 'number' &&
        Number.isFinite(eventTokens.input) &&
        Number.isFinite(eventTokens.output)
      ) {
        const normalized: TokenUsage = {
          input: eventTokens.input,
          output: eventTokens.output,
        };
        const optionalTokens = eventTokens as Record<string, unknown>;
        for (const axis of ['cacheRead', 'cacheWrite'] as const) {
          const value = optionalTokens[axis];
          if (value === undefined) continue;
          if (typeof value === 'number' && Number.isFinite(value)) {
            normalized[axis] = value;
          } else {
            getLog().warn(
              { runId: workflowRunId, stepName: row.step_name, axis, value },
              'db.workflow_dag_node_optional_tokens_invalid_ignored'
            );
          }
        }
        // A node whose own usage was already a floor (a loop total, an OpenCode
        // multi-agent node) keeps the resumed run a floor. Anything other than `true`
        // is ignored without a warn: unlike the numeric axes it carries no total.
        if (optionalTokens.cachePartial === true) {
          normalized.cachePartial = true;
        }
        contribution.tokens = normalized;
      } else {
        getLog().warn(
          { runId: workflowRunId, stepName: row.step_name, tokens: eventTokens },
          'db.workflow_dag_node_tokens_invalid_ignored'
        );
      }
    }
    if (row.event_type !== 'node_skipped_prior_success' && record.rawUsage.costUsd !== undefined) {
      const eventCost = record.rawUsage.costUsd;
      // Same guard shape as tokens: a non-finite value from a provider must not
      // silently poison the total (NaN > 0 is false, which would drop the run's
      // cost from the persisted metadata with no trace).
      if (typeof eventCost === 'number' && Number.isFinite(eventCost)) {
        contribution.costUsd = eventCost;
      } else {
        getLog().warn(
          { runId: workflowRunId, stepName: row.step_name, costUsd: eventCost },
          'db.workflow_dag_node_cost_invalid_ignored'
        );
      }
    }
    if (contribution.tokens !== undefined || contribution.costUsd !== undefined) {
      usageContributions.push(contribution);
    }
  }
  const authoritativeInstancePrefixes = [...authoritativeInstanceScopes].map(scope => `${scope}__`);
  const countedUsage = usageContributions.filter(
    contribution =>
      !authoritativeInstancePrefixes.some(prefix => contribution.stepName.startsWith(prefix))
  );
  return {
    unfinishedInvocations,
    completedNodeOutputs,
    fanOutSnapshots,
    unresolvedNodeStarts,
    tokens: mergeTokenUsage(
      countedUsage.flatMap(contribution =>
        contribution.tokens === undefined ? [] : [contribution.tokens]
      )
    ),
    costUsd: countedUsage.reduce((total, contribution) => total + (contribution.costUsd ?? 0), 0),
  };
}
