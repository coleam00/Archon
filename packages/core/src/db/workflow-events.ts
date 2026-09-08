/**
 * Database operations for workflow events (lean UI-relevant events).
 *
 * Stores node lifecycle, parallel agent status, artifacts, and errors.
 * Verbose assistant/tool content stays in JSONL logs only.
 *
 * Ordinary observability writes are fire-and-forget. Correctness-critical lifecycle
 * writes use `persistWorkflowEvent` and propagate storage failure to their owner.
 * Read operations also throw on error — callers own the degradation policy.
 */
import { pool, getDialect, getDatabaseType } from './connection';
import { toDbTimestampParam } from './timestamps';
import type { QueryResult } from './adapters/types';
import type { WorkflowEventRow } from '../schemas/workflow-event';
import { createLogger } from '@archon/paths';
import { mergeTokenUsage, type TokenUsage } from '@archon/providers/types';
import { readFile } from 'node:fs/promises';
import type { FanOutInstanceSnapshot } from '@archon/workflows/fan-out-identity';
import {
  NODE_LIFECYCLE_EVENT_TYPES,
  type NodeLifecycleEventType,
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

/** The column payload for a single workflow-event row. */
export interface WorkflowEventInput {
  workflow_run_id: string;
  event_type: WorkflowEventType;
  step_index?: number;
  step_name?: string;
  data?: Record<string, unknown>;
}

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
export async function createWorkflowEvent(data: WorkflowEventInput): Promise<void> {
  try {
    await insertWorkflowEvent((sql, params) => pool.query(sql, params), data);
  } catch (error) {
    getLog().error(
      { err: error as Error, eventType: data.event_type, runId: data.workflow_run_id },
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
export async function listWorkflowEvents(workflowRunId: string): Promise<WorkflowEventRow[]> {
  try {
    const result = await pool.query<WorkflowEventRow>(
      `SELECT * FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1
       ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
      [workflowRunId]
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
        [workflowRunId, toDbTimestampParam(since)]
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
    const params: unknown[] = [toDbTimestampParam(after)];
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
 * from rows that are not marked `data.aggregate`. Failed rows contribute spend but
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
 * - `aggregate: true` rows are derived from other rows already in this log — a
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
  eventType: NodeLifecycleEventType
): void {
  if (!stepName) return;
  if (eventType === 'node_started') {
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

export async function getDagResumeSnapshot(workflowRunId: string): Promise<{
  completedNodeOutputs: Map<
    string,
    { output: string; structuredOutput?: unknown; declaredFields?: readonly string[] }
  >;
  fanOutSnapshots: Map<string, readonly FanOutInstanceSnapshot[]>;
  unresolvedNodeStarts: Set<string>;
  tokens?: TokenUsage;
  costUsd: number;
}> {
  const result = await pool.query<{
    step_name: string | null;
    event_type: NodeLifecycleEventType | 'fan_out_instances';
    data: string | Record<string, unknown>;
  }>(
    `SELECT step_name, event_type, data FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1 AND event_type IN (${NODE_LIFECYCLE_EVENT_TYPES.map(
       (_, index) => `$${String(index + 2)}`
     ).join(', ')}, $${String(NODE_LIFECYCLE_EVENT_TYPES.length + 2)})
     ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
    [workflowRunId, ...NODE_LIFECYCLE_EVENT_TYPES, 'fan_out_instances']
  );
  const completedNodeOutputs = new Map<
    string,
    { output: string; structuredOutput?: unknown; declaredFields?: readonly string[] }
  >();
  const fanOutSnapshots = new Map<string, readonly FanOutInstanceSnapshot[]>();
  const unresolvedNodeStarts = new Set<string>();
  // Collected and merged once at the end rather than folded pairwise: a pairwise fold
  // cannot tell "one of five contributions reported" from "one of two" (#2662).
  const usageContributions: { stepName: string; tokens?: TokenUsage; costUsd?: number }[] = [];
  const authoritativeInstanceScopes = new Set<string>();
  for (const row of result.rows) {
    if (!row.step_name) continue;
    if (row.event_type !== 'fan_out_instances') {
      foldActiveNodeIds(unresolvedNodeStarts, row.step_name, row.event_type);
    }
    let data: Record<string, unknown>;
    try {
      data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch (parseErr) {
      getLog().warn(
        { err: parseErr as Error, runId: workflowRunId, stepName: row.step_name },
        'db.workflow_dag_node_output_parse_failed'
      );
      continue;
    }
    if (row.event_type === 'fan_out_instances') {
      if (!fanOutSnapshots.has(row.step_name)) {
        const snapshots = parseFanOutSnapshots(data.instances);
        if (snapshots !== undefined) fanOutSnapshots.set(row.step_name, snapshots);
      }
      continue;
    }
    if (row.event_type === 'node_started' || row.event_type === 'node_skipped') continue;
    if (row.event_type === 'node_failed') {
      // A later failure for this step supersedes any earlier node_completed /
      // node_skipped_prior_success entry (#2705 R2) — otherwise a node the engine's own
      // prior-cache invalidation re-executed, and which then genuinely failed, is
      // reported as a cached success again on a subsequent resume.
      completedNodeOutputs.delete(row.step_name);
    } else if (typeof data.node_output === 'string') {
      // A bash/script node's persisted text is a bounded preview once it exceeded the
      // truncation cap; the full bytes were spilled to `node_output_spill_path` at write
      // time (#2726). Prefer the spill so a resumed run's `$node.output`/`.field` sees
      // exactly what a fresh run's in-process consumer would have. A missing/unreadable
      // spill degrades to the preview rather than failing resume — this is not a DB
      // error, so it must not propagate as one (see this function's own doc comment).
      //
      // The spill file is addressed by a stable, node-scoped filename that a later
      // execution of the SAME node overwrites in place (by design — see
      // `formatPersistedNodeOutput`'s doc comment). Its write races this row's own
      // fire-and-forget insert (`createWorkflowEvent` never awaited, never throws), so a
      // process crash between "spill file overwritten by a later execution" and "this
      // row's insert lands" could otherwise leave an older, still-durable row pointing at
      // a NEWER execution's content. Guard against that by validating the file's actual
      // byte length against this row's own recorded `node_output_original_bytes` before
      // trusting it — a mismatch means the file no longer describes this row, so fall
      // back to the bounded preview exactly like a missing spill would.
      let output = data.node_output;
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
      // The field-access contract this node completed under (#2453), written only by
      // `workflow:` nodes — the child owns that projection, so re-deriving it from the
      // parent's own definition on resume would lose it. Accepted only as an array of
      // strings; anything else is corrupt and degrades to "no persisted contract".
      const rawDeclaredFields = data.declared_fields;
      const declaredFields =
        Array.isArray(rawDeclaredFields) && rawDeclaredFields.every(f => typeof f === 'string')
          ? rawDeclaredFields
          : undefined;
      completedNodeOutputs.set(row.step_name, {
        output,
        // The node's logical value (#2637), persisted beside its text by the emit
        // sites (and copied forward by node_skipped_prior_success re-emits). Absent
        // on pre-#2637 rows — the executor then falls back to text re-parsing.
        ...(data.structured_output !== undefined
          ? { structuredOutput: data.structured_output }
          : {}),
        ...(declaredFields !== undefined ? { declaredFields } : {}),
      });
    }
    // Composed-instance terminals are the durable accounting source for their whole
    // scope. Their inner rows are observability writes and may be missing after a crash.
    const isAuthoritativeInstanceUsage =
      data.type === 'compose_fan_out_instance' &&
      (row.event_type === 'node_completed' || row.event_type === 'node_failed');
    if (isAuthoritativeInstanceUsage) authoritativeInstanceScopes.add(row.step_name);
    // Other aggregate rows merely restate usage already carried by their leaves.
    if (data.aggregate === true && !isAuthoritativeInstanceUsage) continue;
    const contribution: { stepName: string; tokens?: TokenUsage; costUsd?: number } = {
      stepName: row.step_name,
    };
    if (row.event_type !== 'node_skipped_prior_success' && data.tokens !== undefined) {
      const eventTokens = data.tokens;
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
    if (row.event_type !== 'node_skipped_prior_success' && data.cost_usd !== undefined) {
      const eventCost = data.cost_usd;
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
