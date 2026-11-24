/**
 * Ends of an item (`remote_agent_item_ends`) and the runs each saw
 * (`remote_agent_item_end_runs`): append-only facts, never updated or deleted. An end holds
 * until work starts on the item again (`schemas/item-end.ts`): a run on the item the end did
 * not see, a run resumed since (its `active_phase_started_at` changed), a live run, or a
 * queued start. The rule compares run identities and copied values, never clocks, so a run
 * whose transaction overlapped the end's, or a run row id reused after cleanup, still opens
 * the item. Opening writes nothing, and deleting runs the end saw leaves it holding.
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
import { getDatabase, getDatabaseType, pool } from './connection';
import { actColumns, actRead, type ActColumns } from './item-act';
import type { TransactionQuery } from './resource-slots';
import { getLog } from './workflow-run-shared';

interface EndRow extends ActColumns {
  id: string;
  reason: string;
  run_id: string | null;
}

function endRead(row: EndRow): ItemEnd | ItemEndDegraded {
  const parsed = itemEndSchema.safeParse({
    kind: 'ended',
    id: row.id,
    reason: row.reason,
    ...actRead(row),
    runId: row.run_id,
  });
  if (parsed.success) return parsed.data;
  // The parse error can quote the stored reason.
  getLog().error({ endId: row.id }, 'item_end_unreadable');
  return { type: 'degraded', reason: 'end_unreadable', endId: row.id };
}

const LIVE = "('pending', 'running', 'paused')";

/**
 * SQL true while end `e` holds: every run on its item is one the end saw, not resumed since
 * (resume is the only write of `active_phase_started_at`), no run on it is live, and no start
 * is queued on it.
 */
function holds(): string {
  const same = getDatabaseType() === 'sqlite' ? 'IS' : 'IS NOT DISTINCT FROM';
  return `NOT EXISTS (
      SELECT 1 FROM remote_agent_workflow_runs n
      WHERE n.item_id = e.item_id
        AND (n.status IN ${LIVE} OR NOT EXISTS (
          SELECT 1 FROM remote_agent_item_end_runs k
          WHERE k.end_id = e.id AND k.run_id = CAST(n.id AS TEXT)
            AND k.active_phase_started_at ${same} n.active_phase_started_at
        ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM remote_agent_resource_start_requests q
      WHERE q.item_id = e.item_id AND q.status = 'queued'
    )`;
}

/**
 * The first work on item `itemId` that is still active or waiting: a live run on it or below
 * one of its runs, a queued start, an open ask, an open wait. Null when there is none.
 */
async function blockerOf(query: TransactionQuery, itemId: string): Promise<ItemEndBlocker | null> {
  const run = await query<{ id: string; status: string }>(
    `WITH RECURSIVE tree(id) AS (
       SELECT id FROM remote_agent_workflow_runs WHERE item_id = $1
       UNION SELECT c.id FROM remote_agent_workflow_runs c JOIN tree t ON c.parent_run_id = t.id
     )
     SELECT CAST(r.id AS TEXT) AS id, r.status FROM remote_agent_workflow_runs r
     JOIN tree t ON t.id = r.id WHERE r.status IN ${LIVE} ORDER BY r.started_at LIMIT 1`,
    [itemId]
  );
  const live = run.rows[0];
  if (live) return itemEndBlockerSchema.parse({ kind: 'run', runId: live.id, status: live.status });
  const queued = await query<{ id: string }>(
    `SELECT CAST(id AS TEXT) AS id FROM remote_agent_resource_start_requests
     WHERE item_id = $1 AND status = 'queued' ORDER BY created_at LIMIT 1`,
    [itemId]
  );
  if (queued.rows[0]) return { kind: 'queued_start', requestId: queued.rows[0].id };
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
 * Record an end on item `itemId`, naming its latest run, and copy the runs it sees on the
 * item. The item is checked after the write, in the same transaction: on SQLite the write
 * holds the database, so no run or start slips in between; on PostgreSQL a run committed
 * before the check is seen, and one committed after it is not among the runs the end saw,
 * so it opens the item. While anything on the item is active or waiting, throws
 * `ItemEndRefusedError` and writes nothing.
 */
export async function recordItemEnd(
  input: { itemId: string; key: string; reason: string } & ItemAct
): Promise<ItemEnd> {
  if (input.reason.trim() === '') throw new Error('An end needs a reason.');
  const tie = getDatabaseType() === 'sqlite' ? 'rowid' : 'id';
  return getDatabase().withTransaction(async query => {
    const result = await query<EndRow>(
      `INSERT INTO remote_agent_item_ends
         (item_id, reason, by_declared, by_user_id, via, from_run_id, from_node_path, created_at,
          run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
         (SELECT CAST(r.id AS TEXT) FROM remote_agent_workflow_runs r WHERE r.item_id = $1
          ORDER BY r.started_at DESC, r.${tie} DESC LIMIT 1))
       RETURNING *`,
      [input.itemId, input.reason, ...actColumns(input)]
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The end was not written');
    // Copied in SQL, so each time compares exactly with the column it came from.
    await query(
      `INSERT INTO remote_agent_item_end_runs (end_id, run_id, active_phase_started_at)
       SELECT $1, CAST(r.id AS TEXT), r.active_phase_started_at
       FROM remote_agent_workflow_runs r WHERE r.item_id = $2`,
      [row.id, input.itemId]
    );
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
     WHERE e.item_id = $1 AND ${holds()}
     ORDER BY e.seq DESC LIMIT 1`,
    [itemId]
  );
  const row = result.rows[0];
  return row === undefined ? null : endRead(row);
}
