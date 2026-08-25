/**
 * Database operations for workflow events (lean UI-relevant events).
 *
 * Stores step transitions, parallel agent status, artifacts, and errors.
 * Verbose assistant/tool content stays in JSONL logs only.
 *
 * All write operations use fire-and-forget pattern (catch + log, never throw)
 * because workflow execution must not fail due to event logging.
 * Read operations also throw on error — callers own the degradation policy.
 */
import { pool, getDialect, getDatabaseType } from './connection';
import type { QueryResult } from './adapters/types';
import type { WorkflowEventRow } from '../schemas/workflow-event';
import { createLogger } from '@archon/paths';
import { mergeTokenUsage, type TokenUsage } from '@archon/providers/types';
import { readFile } from 'node:fs/promises';

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

/** The column payload for a single workflow-event row. */
export interface WorkflowEventInput {
  workflow_run_id: string;
  event_type: string;
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

/**
 * Persist an event whose row is part of engine state rather than best-effort
 * observability. Unlike {@link createWorkflowEvent}, this rejects on insert
 * failure so the caller can refuse the governed action that depends on it.
 */
export async function createRequiredWorkflowEvent(data: WorkflowEventInput): Promise<void> {
  await insertWorkflowEvent((sql, params) => pool.query(sql, params), data);
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
        [workflowRunId, since.toISOString()]
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
export async function getDagResumeSnapshot(workflowRunId: string): Promise<{
  completedNodeOutputs: Map<string, { output: string; structuredOutput?: unknown }>;
  terminalNodeIds: ReadonlySet<string>;
  terminalUsageByNode: ReadonlyMap<string, { costUsd: number; tokens?: TokenUsage }>;
  tokens?: TokenUsage;
  costUsd: number;
  /**
   * Count of required `work_unit_charged` rows — the total the run-wide budget ceiling
   * (#1961) checks on resume. Node starts remain best-effort observability events;
   * governed units use the throwing insert boundary so every live charge is durable.
   */
  workUnits: number;
}> {
  const result = await pool.query<{
    step_name: string | null;
    event_type:
      | 'node_completed'
      | 'node_failed'
      | 'node_skipped_prior_success'
      | 'work_unit_charged';
    data: string | Record<string, unknown>;
  }>(
    `SELECT step_name, event_type, data FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1 AND event_type IN ('node_completed', 'node_failed', 'node_skipped_prior_success', 'work_unit_charged')
     ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
    [workflowRunId]
  );
  const completedNodeOutputs = new Map<string, { output: string; structuredOutput?: unknown }>();
  const terminalNodeIds = new Set<string>();
  const terminalUsageParts = new Map<string, { costUsd: number; tokens: TokenUsage[] }>();
  // Collected and merged once at the end rather than folded pairwise: a pairwise fold
  // cannot tell "one of five contributions reported" from "one of two" (#2662).
  const usages: TokenUsage[] = [];
  let costUsd = 0;
  let workUnits = 0;
  for (const row of result.rows) {
    if (!row.step_name) continue;
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
    if (row.event_type === 'work_unit_charged') {
      // Required persisted trace of either a node attempt or child spawn decision.
      workUnits++;
      continue;
    }
    const isTerminal = row.event_type === 'node_completed' || row.event_type === 'node_failed';
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
      completedNodeOutputs.set(row.step_name, {
        output,
        // The node's logical value (#2637), persisted beside its text by the emit
        // sites (and copied forward by node_skipped_prior_success re-emits). Absent
        // on pre-#2637 rows — the executor then falls back to text re-parsing.
        ...(data.structured_output !== undefined
          ? { structuredOutput: data.structured_output }
          : {}),
      });
    }
    // A derived row restates usage that other rows in this same log already carry.
    if (data.aggregate === true) continue;
    let usageAccounted = false;
    let rowTokens: TokenUsage | undefined;
    let rowCostUsd = 0;
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
        usages.push(normalized);
        rowTokens = normalized;
        usageAccounted = true;
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
      if (typeof eventCost === 'number' && Number.isFinite(eventCost) && eventCost >= 0) {
        costUsd += eventCost;
        rowCostUsd = eventCost;
        usageAccounted = true;
      } else {
        getLog().warn(
          { runId: workflowRunId, stepName: row.step_name, costUsd: eventCost },
          'db.workflow_dag_node_cost_invalid_ignored'
        );
      }
    }
    if (isTerminal && usageAccounted) {
      terminalNodeIds.add(row.step_name);
    }
    if (isTerminal && usageAccounted && data.type === 'workflow') {
      const prior = terminalUsageParts.get(row.step_name) ?? { costUsd: 0, tokens: [] };
      prior.costUsd += rowCostUsd;
      if (rowTokens !== undefined) prior.tokens.push(rowTokens);
      terminalUsageParts.set(row.step_name, prior);
    }
  }
  return {
    completedNodeOutputs,
    terminalNodeIds,
    terminalUsageByNode: new Map(
      [...terminalUsageParts].map(([nodeId, usage]) => {
        const tokens = mergeTokenUsage(usage.tokens);
        return [nodeId, { costUsd: usage.costUsd, ...(tokens !== undefined ? { tokens } : {}) }];
      })
    ),
    tokens: mergeTokenUsage(usages),
    costUsd,
    workUnits,
  };
}
