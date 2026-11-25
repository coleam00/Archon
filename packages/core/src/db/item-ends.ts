/**
 * Ends of an item (`remote_agent_item_ends`) and the runs each saw
 * (`remote_agent_item_end_runs`, the item's steps and every run below them): append-only
 * facts, never updated or deleted. An end is an operator's act (`archon workflow end`) or a
 * finishing outcome a workflow declares (`returns.ends`), which the engine records in the
 * write that completes the run. An end holds until work starts on the item again
 * (`schemas/item-end.ts`): a step in the item's tree the end did not see, a run resumed since
 * (its execution claim changed), a live run, or a queued start. A run that observes the item
 * (`stepRun`) is not in that tree, so it neither opens an end nor keeps one from holding. The
 * rule reads the runs that exist now and compares run identities and claims, never clocks, so
 * a run whose transaction overlapped the end's, a run row id reused after cleanup, or two
 * resumes in one second still open the item. Deleting runs leaves no trace: deleting runs the
 * end saw keeps it holding, and deleting the run that opened the item makes the end hold
 * again, as the operator left it.
 */
import {
  itemEndBlockerSchema,
  itemEndSchema,
  ItemEndRefusedError,
  type ItemEnd,
  type ItemEndBlocker,
  type ItemEndDegraded,
} from '@archon/workflows/schemas/item-end';
import { askItemRef } from '@archon/workflows/attention-item-refs';
import type { ItemAct } from '@archon/workflows/schemas/item-act';
import { EXECUTION_CLAIM_METADATA_KEY } from '@archon/workflows/store';
import { observesItemRecorded } from '@archon/workflows/schemas/run-metadata';
import { getDatabase, getDatabaseType, getDialect, pool } from './connection';
import { actColumns, actRead, type ActColumns } from './item-act';
import { stepRun } from './item-step';
import { parseStoredJson } from './resource-starts';
import type { TransactionQuery } from './resource-slots';
import { getLog } from './workflow-run-shared';

interface EndRow extends ActColumns {
  id: string;
  reason: string;
}

function endRead(row: EndRow): ItemEnd | ItemEndDegraded {
  const parsed = itemEndSchema.safeParse({
    kind: 'ended',
    id: row.id,
    reason: row.reason,
    ...actRead(row),
  });
  if (parsed.success) return parsed.data;
  // The parse error can quote the stored reason.
  getLog().error({ endId: row.id }, 'item_end_unreadable');
  return { type: 'degraded', reason: 'end_unreadable', endId: row.id };
}

const LIVE = "('pending', 'running', 'paused')";

/** The execution claim in run `alias`'s metadata, as text. */
function claim(alias: string): string {
  return getDialect().jsonText(`${alias}.metadata`, EXECUTION_CLAIM_METADATA_KEY);
}

/**
 * The steps of item `itemId` (SQL) and every run below them, as a recursive `tree(id)`. With
 * `through` (SQL naming a run), only the steps that started no later than that run, in the
 * order `listStoppedItemRuns` reads them.
 */
function runTree(itemId: string, through?: string): string {
  const tie = getDatabaseType() === 'sqlite' ? 'rowid' : 'id';
  const notAfter =
    through === undefined
      ? ''
      : ` AND NOT EXISTS (SELECT 1 FROM remote_agent_workflow_runs f WHERE f.id = ${through}
            AND (s.started_at > f.started_at OR (s.started_at = f.started_at AND s.${tie} > f.${tie})))`;
  return `WITH RECURSIVE tree(id) AS (
      SELECT s.id FROM remote_agent_workflow_runs s
       WHERE s.item_id = ${itemId} AND ${stepRun('s')}${notAfter}
      UNION SELECT c.id FROM remote_agent_workflow_runs c JOIN tree t ON c.parent_run_id = t.id
    )`;
}

/**
 * SQL true while a run in the tree of end `e`'s item is one the end did not see, or was
 * resumed since: every resume writes a fresh execution claim into the run's metadata.
 */
function opened(): string {
  const same = getDatabaseType() === 'sqlite' ? 'IS' : 'IS NOT DISTINCT FROM';
  return `EXISTS (
      ${runTree('e.item_id')}
      SELECT 1 FROM remote_agent_workflow_runs n JOIN tree t ON t.id = n.id
      WHERE NOT EXISTS (
        SELECT 1 FROM remote_agent_item_end_runs k
        WHERE k.end_id = e.id AND k.run_id = CAST(n.id AS TEXT)
          AND k.execution_claim ${same} ${claim('n')}
      )
    )`;
}

/**
 * SQL true while no step in the tree of end `e`'s item opened it and none is live. An end
 * holds while this is true and no step is queued on the item (`queuedStep`).
 */
function holdsOverRuns(): string {
  return `NOT ${opened()}
    AND NOT EXISTS (
      ${runTree('e.item_id')}
      SELECT 1 FROM remote_agent_workflow_runs n JOIN tree t ON t.id = n.id
      WHERE n.status IN ${LIVE}
    )`;
}

/**
 * The oldest start queued on item `itemId` that will run a step, by request id, or undefined.
 * A queued start has no run row yet; whether it observes is in the run its prepared launch
 * will create (`observes_item` in `launch.run.metadata`), read here because the launch is
 * stored as text. A launch that does not read counts as a step, as every start did before.
 */
async function queuedStep(query: TransactionQuery, itemId: string): Promise<string | undefined> {
  const queued = await query<{ id: string; launch: unknown }>(
    `SELECT CAST(id AS TEXT) AS id, launch FROM remote_agent_resource_start_requests
     WHERE item_id = $1 AND status = 'queued' ORDER BY created_at`,
    [itemId]
  );
  return queued.rows.find(row => !launchObservesItem(row.launch))?.id;
}

function launchObservesItem(launch: unknown): boolean {
  try {
    const run = (parseStoredJson(launch) as { run?: { metadata?: unknown } } | null)?.run;
    return observesItemRecorded(run?.metadata);
  } catch {
    return false;
  }
}

/**
 * The first work on item `itemId` that is still active or waiting: a live step on it or below
 * one of its steps, a queued start, an open ask, an open wait. Null when there is none.
 */
async function blockerOf(query: TransactionQuery, itemId: string): Promise<ItemEndBlocker | null> {
  const run = await query<{ id: string; status: string }>(
    `${runTree('$1')}
     SELECT CAST(r.id AS TEXT) AS id, r.status FROM remote_agent_workflow_runs r
     JOIN tree t ON t.id = r.id WHERE r.status IN ${LIVE} ORDER BY r.started_at LIMIT 1`,
    [itemId]
  );
  const live = run.rows[0];
  if (live) return itemEndBlockerSchema.parse({ kind: 'run', runId: live.id, status: live.status });
  const queued = await queuedStep(query, itemId);
  if (queued !== undefined) return { kind: 'queued_start', requestId: queued };
  const ask = await query<{ id: string }>(
    'SELECT id FROM remote_agent_item_asks WHERE item_id = $1 AND closed_as IS NULL LIMIT 1',
    [itemId]
  );
  if (ask.rows[0]) return { kind: 'open_ask', ref: askItemRef(ask.rows[0].id) };
  const wait = await query<{ run_id: string }>(
    'SELECT run_id FROM remote_agent_item_waits WHERE item_id = $1 AND closed_as IS NULL LIMIT 1',
    [itemId]
  );
  if (wait.rows[0]) return { kind: 'open_wait', runId: wait.rows[0].run_id };
  return null;
}

/**
 * Write an end on item `itemId` and copy the runs it sees on the item and below its steps,
 * inside the caller's transaction. Refuses nothing: the operator's end checks the item after
 * it, and the engine's needs no check.
 */
async function insertItemEnd(
  query: TransactionQuery,
  input: { itemId: string; reason: string } & ItemAct,
  /** The run the end is the outcome of: steps started after it stay unseen, so they open it. */
  through?: string
): Promise<EndRow> {
  const result = await query<EndRow>(
    `INSERT INTO remote_agent_item_ends
       (item_id, reason, by_declared, by_user_id, via, from_run_id, from_node_path, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [input.itemId, input.reason, ...actColumns(input)]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The end was not written');
  // Copied in SQL, so each time compares exactly with the column it came from.
  await query(
    `${runTree('$2', through === undefined ? undefined : '$3')}
     INSERT INTO remote_agent_item_end_runs
       (end_id, run_id, execution_claim)
     SELECT $1, CAST(r.id AS TEXT), ${claim('r')}
     FROM remote_agent_workflow_runs r JOIN tree t ON t.id = r.id`,
    through === undefined ? [row.id, input.itemId] : [row.id, input.itemId, through]
  );
  return row;
}

/**
 * The end a run's finishing outcome records on its item (`returns.ends`), inside the
 * transaction that completes the run and only when that write won. It is the end
 * `archon workflow end` writes, from the engine, and no blocker refuses it. It sees the steps
 * up to the finishing run only: a step started after it is newer work, which opens the end,
 * as does a step still live or one queued on the item. Asks and waits stay as they are; the
 * attention queue leaves them out while the end holds.
 */
export async function recordCompletedRunEnd(
  query: TransactionQuery,
  runId: string,
  end: { readonly reason: string; readonly node: string }
): Promise<void> {
  const found = await query<{ item_id: string | null }>(
    'SELECT item_id FROM remote_agent_workflow_runs WHERE id = $1',
    [runId]
  );
  const itemId = found.rows[0]?.item_id ?? null;
  if (itemId === null)
    throw new Error(`Run '${runId}' ended its item but has no item; an end belongs to an item`);
  await insertItemEnd(
    query,
    { itemId, reason: end.reason, via: 'engine', by: null, fromRun: { runId, nodePath: end.node } },
    runId
  );
}

/**
 * Record an end on item `itemId` and copy the runs it sees on the item and below its runs.
 * The item is checked after the write, in the same transaction: on SQLite the write
 * holds the database, so no run or start slips in between; on PostgreSQL a run committed
 * before the check is seen, and one committed after it is not among the runs the end saw,
 * so it opens the item. While anything on the item is active or waiting, throws
 * `ItemEndRefusedError` and writes nothing.
 */
export async function recordItemEnd(
  input: { itemId: string; key: string; reason: string } & ItemAct
): Promise<ItemEnd> {
  if (input.reason.trim() === '') throw new Error('An end needs a reason.');
  return getDatabase().withTransaction(async query => {
    const row = await insertItemEnd(query, input);
    const blocker = await blockerOf(query, input.itemId);
    if (blocker !== null) throw new ItemEndRefusedError(input.key, blocker);
    const read = endRead(row);
    if ('type' in read) throw new Error(`End '${row.id}' was written but does not read back`);
    return read;
  });
}

/** The newest end on item `itemId` while it holds, or null. */
export async function getHoldingItemEnd(itemId: string): Promise<ItemEnd | ItemEndDegraded | null> {
  const result = await pool.query<EndRow>(
    `SELECT e.* FROM remote_agent_item_ends e
     WHERE e.item_id = $1 AND ${holdsOverRuns()}
     ORDER BY e.seq DESC LIMIT 1`,
    [itemId]
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if ((await queuedStep((sql, params) => pool.query(sql, params), itemId)) !== undefined)
    return null;
  return endRead(row);
}
