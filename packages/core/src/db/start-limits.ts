/**
 * A binding's start limit on an item, in the SQL store: what admission counts and records
 * (`countStartLimits`), what the item read reports (`readItemStartLimits`), and where the
 * limit last reset. The arithmetic is `@archon/workflows/start-limit`'s, for both.
 *
 *
 * The write that completes a run on an item with a start limit or a grant records the
 * reset in event order, not by time: under the admission lock, so no admission interleaves,
 * it records the highest request `queue_position` so far and the item's limit requests
 * still queued. Starts after the reset are the requests above that position and those that
 * were still waiting, which run after it. Whole-second timestamps could not tell a start
 * from a reset in the same second. The record is kept apart from the run row, so run
 * cleanup cannot undo a reset. An item with neither a limit nor a grant has nothing to
 * reset: every limited start on it comes after.
 */
import { z } from 'zod';
import type { ItemStartLimits } from '@archon/workflows/resource-start-store';
import {
  ASKS_SETTLED_SOURCE_ACTOR,
  RUN_ENDED_SOURCE_ACTOR,
  sourceReceiptInputSchema,
  type ResourceStartBindingIntent,
  type StartLimit,
} from '@archon/workflows/schemas/resource-start';
import {
  EXECUTION_OWNER_METADATA_KEY,
  itemStoppedMetadata,
  type StoppedLimit,
} from '@archon/workflows/schemas/run-metadata';
import {
  startLimitRefusal,
  startLimitStanding,
  storedStartLimitSchema,
  type StartLimitReset,
  type StartLimitRow,
} from '@archon/workflows/start-limit';
import { getDatabase, getDialect } from './connection';
import { lockAdmission, type TransactionQuery as Query } from './resource-slots';
import { toHydratedTimestamp } from './timestamps';

/** A JSON column reads as text on SQLite and as a value on PostgreSQL. */
function parseStoredJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** What a binding start's request records for its start limit; see `@archon/workflows/start-limit`. */
export interface StartLimitColumns {
  startLimit: string | null;
  grantsLimit: string | null;
}

/**
 * A binding's start limit and the limit it grants, from their own columns. Newer binaries
 * may add keys to the stored limit, so unknown keys are stripped, not refused.
 */
export function storedLimitFields(
  startLimit: unknown,
  grantsLimit: unknown
): Pick<ResourceStartBindingIntent, 'limit' | 'grants'> {
  return {
    ...(startLimit == null
      ? {}
      : { limit: storedStartLimitSchema.parse(parseStoredJson(startLimit)) }),
    ...(typeof grantsLimit === 'string' ? { grants: grantsLimit } : {}),
  };
}

const LIMIT_ROWS = '(start_limit IS NOT NULL OR grants_limit IS NOT NULL)';

/** Record the completion of run `runId` as a reset, inside the transaction that completes it. */
export async function recordStartLimitReset(query: Query, runId: string): Promise<void> {
  const run = (
    await query<{ item_id: string | null; workflow_name: string; completed_at: unknown }>(
      'SELECT item_id, workflow_name, completed_at FROM remote_agent_workflow_runs WHERE id = $1',
      [runId]
    )
  ).rows[0];
  if (!run?.item_id || run.completed_at == null) return;
  const limited = await query(
    `SELECT 1 FROM remote_agent_resource_start_requests WHERE item_id = $1 AND ${LIMIT_ROWS} LIMIT 1`,
    [run.item_id]
  );
  if (limited.rows.length === 0) return;
  // Taken only here, after the run row, and no admission updates an existing run row, so
  // this cannot deadlock with admission.
  await lockAdmission(query);
  const last = await query<{ position: number | string | null }>(
    'SELECT MAX(queue_position) AS position FROM remote_agent_resource_start_requests'
  );
  const queued = await query<{ id: string }>(
    `SELECT id FROM remote_agent_resource_start_requests
      WHERE item_id = $1 AND status = 'queued' AND ${LIMIT_ROWS}`,
    [run.item_id]
  );
  await query(
    `INSERT INTO remote_agent_start_limit_resets
       (item_id, workflow_name, reset_at, after_position, queued_ids)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      run.item_id,
      run.workflow_name,
      run.completed_at,
      Number(last.rows[0]?.position ?? 0),
      JSON.stringify(queued.rows.map(row => String(row.id))),
    ]
  );
}

const queuedIdsSchema = z.array(z.string());

/** The latest reset of `workflow` on the item, or null when it never reset there. */
export async function lastStartLimitReset(
  query: Query,
  itemId: string,
  workflow: string | undefined
): Promise<StartLimitReset | null> {
  if (workflow === undefined) return null;
  const row = (
    await query<{
      reset_at: string | Date;
      after_position: number | string;
      queued_ids: unknown;
    }>(
      `SELECT reset_at, after_position, queued_ids FROM remote_agent_start_limit_resets
        WHERE item_id = $1 AND workflow_name = $2 ORDER BY id DESC LIMIT 1`,
      [itemId, workflow]
    )
  ).rows[0];
  if (row === undefined) return null;
  const ids = parseStoredJson(row.queued_ids);
  return {
    at: toHydratedTimestamp(row.reset_at).toISOString(),
    afterPosition: Number(row.after_position),
    queuedIds: queuedIdsSchema.parse(ids),
  };
}

interface StartLimitRequestRow {
  id: string;
  queue_position: number | string;
  status: StartLimitRow['status'];
  ended_unstarted: boolean | number;
  start_limit: unknown;
  grants_limit: unknown;
}

/**
 * The item's limit requests. A binding start's run is written at admission with no execution
 * owner, and the claim records one in the update that makes it running, so a terminal run
 * without one ended while still pending: its start never ran (`endedUnstarted`). A request
 * whose run row is gone keeps counting.
 */
const startLimitRowsSql =
  (): string => `SELECT q.id, q.queue_position, q.status, q.start_limit, q.grants_limit,
       CASE WHEN q.status = 'admitted' AND w.status IN ('completed', 'failed', 'cancelled')
             AND ${getDialect().jsonText('w.metadata', EXECUTION_OWNER_METADATA_KEY)} IS NULL
            THEN 1 ELSE 0 END AS ended_unstarted
       FROM remote_agent_resource_start_requests q
       LEFT JOIN remote_agent_workflow_runs w ON w.id = q.id
      WHERE q.item_id = $1 AND (q.start_limit IS NOT NULL OR q.grants_limit IS NOT NULL)
      ORDER BY q.queue_position`;

function startLimitRow(row: StartLimitRequestRow): StartLimitRow {
  return {
    id: String(row.id),
    // PostgreSQL returns a BIGSERIAL as a string.
    position: Number(row.queue_position),
    status: row.status,
    endedUnstarted: Number(row.ended_unstarted) === 1,
    counted:
      row.start_limit == null
        ? null
        : storedStartLimitSchema.parse(parseStoredJson(row.start_limit)),
    grant: typeof row.grants_limit === 'string' ? row.grants_limit : null,
  };
}

/**
 * Count a binding start against its start limit on the item, inside the admitting
 * transaction after `lockAdmission`, so two starts cannot both take the last one. Returns
 * what the start's request records, or why it is refused. A limited start on no item is
 * refused: the count is per item, and letting it through would start it without a limit.
 * A grant on no item raises nothing. A start refused at its limit may stop its item
 * (`recordStartLimitStop`); `start` names the receipt, binding and launch it was for.
 */
export async function countStartLimits(
  query: Query,
  item: { id: string; key: string } | null,
  limit: StartLimit | undefined,
  grants: string | undefined,
  start: { receiptId: string; bindingId: string; persisted: ResourceStartBindingIntent }
): Promise<StartLimitColumns | { refused: string }> {
  const grantsLimit = item === null ? null : (grants ?? null);
  if (limit === undefined) return { startLimit: null, grantsLimit };
  if (item === null)
    return {
      refused: `Start limit '${limit.name}' counts starts per item, and this start names no item.`,
    };
  const rows = (await query<StartLimitRequestRow>(startLimitRowsSql(), [item.id])).rows.map(
    startLimitRow
  );
  const standing = startLimitStanding(
    limit,
    rows,
    await lastStartLimitReset(query, item.id, limit.resetOn)
  );
  if (standing.left === 0) {
    const { name, starts, granted, used } = standing;
    const { bindingId, persisted } = start;
    const stop = {
      name,
      starts,
      granted,
      used,
      bindingId,
      workflow: persisted.launch.workflowName,
    };
    await recordStartLimitStop(query, start.receiptId, item.id, stop);
    return { refused: startLimitRefusal(standing, item.key) };
  }
  return { startLimit: JSON.stringify(limit), grantsLimit };
}

/**
 * Record that a start refused at its limit stopped its item, inside the refusing
 * transaction: on the completed run whose end (a run-ended binding) or settled asks (an
 * asks-settled binding) caused the start, which is then the item's last step. The
 * attention queue lists it as `stopped`, with the limit, while that run is the item's
 * newest. A start caused by anything else (a fire, a schedule, a node) has no such run, and
 * a run that still has an open ask or wait on the item is not stopped.
 */
async function recordStartLimitStop(
  query: Query,
  receiptId: string,
  itemId: string,
  limit: StoppedLimit
): Promise<void> {
  const receipt = (
    await query<{ source_actor: unknown }>(
      'SELECT source_actor FROM remote_agent_start_receipts WHERE id = $1',
      [receiptId]
    )
  ).rows[0];
  const actor = sourceReceiptInputSchema.shape.sourceActor.safeParse(
    receipt === undefined ? null : parseStoredJson(receipt.source_actor)
  );
  const source = actor.success ? actor.data : undefined;
  if (source?.source !== RUN_ENDED_SOURCE_ACTOR && source?.source !== ASKS_SETTLED_SOURCE_ACTOR)
    return;
  await query(
    `UPDATE remote_agent_workflow_runs SET metadata = ${getDialect().jsonMerge('metadata', 3)}
      WHERE id = $1 AND item_id = $2 AND status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM remote_agent_item_asks
                         WHERE run_id = $4 AND closed_as IS NULL)
        AND NOT EXISTS (SELECT 1 FROM remote_agent_item_waits
                         WHERE run_id = $4 AND closed_as IS NULL)`,
    // The run id twice: the runs table keys it as a UUID on PostgreSQL, asks and waits as text.
    [source.id, itemId, JSON.stringify(itemStoppedMetadata(null, limit)), source.id]
  );
}

/** See `IResourceStartStore.readItemStartLimits`. Each limit stands by its latest recorded spec. */
export async function readItemStartLimits(itemId: string): Promise<ItemStartLimits> {
  const db = getDatabase();
  const query: Query = (sql, params) => db.query(sql, params);
  const found = (await query<StartLimitRequestRow>(startLimitRowsSql(), [itemId])).rows;
  const rows = found.map(startLimitRow);
  const countedUnder: Record<string, string> = {};
  const specs = new Map<string, StartLimit>();
  found.forEach((request, index) => {
    const counted = rows[index]?.counted;
    if (!counted) return;
    countedUnder[request.id] = counted.name;
    // Queue order, so the latest spec of a name wins.
    specs.set(counted.name, counted);
  });
  const limits: ItemStartLimits['limits'] = [];
  for (const spec of specs.values())
    limits.push(
      startLimitStanding(spec, rows, await lastStartLimitReset(query, itemId, spec.resetOn))
    );
  return { limits, countedUnder };
}
