/**
 * Ends of an item (`remote_agent_item_ends`): append-only facts. Each row copies the item's
 * latest run, if any, when it was written (`run_id`, `run_completed_at`). An end holds while
 * that run is still the item's latest and its `completed_at` is unchanged; a newer run or a
 * resume of that run voids it, and no row is ever updated or deleted. The copy is made in
 * SQL so it compares exactly with the column it came from: on SQLite a run's times are
 * second-precision text, which a round trip through a Date would change.
 */
import {
  itemEndSchema,
  type ItemEnd,
  type ItemEndDegraded,
} from '@archon/workflows/schemas/item-end';
import type { ItemAct } from '@archon/workflows/schemas/item-act';
import { getDatabaseType, pool } from './connection';
import { actColumns, actRead, type ActColumns } from './item-act';
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

/**
 * The item's latest run, ordered as `listStoppedItemRuns` and `getItemRuns` order runs: by
 * start time, then insertion order, since SQLite records start time to the second.
 */
function latestRun(column: 'id' | 'completed_at'): string {
  const tie = getDatabaseType() === 'sqlite' ? 'rowid' : 'id';
  const value = column === 'id' ? 'CAST(r.id AS TEXT)' : 'r.completed_at';
  return `(SELECT ${value} FROM remote_agent_workflow_runs r WHERE r.item_id = $1
    ORDER BY r.started_at DESC, r.${tie} DESC LIMIT 1)`;
}

/**
 * Record an end on item `itemId`, copying its latest run. Whether anything on the item is
 * still active is checked by the caller; a run that starts after the check voids the end.
 */
export async function recordItemEnd(
  input: { itemId: string; reason: string } & ItemAct
): Promise<ItemEnd> {
  if (input.reason.trim() === '') throw new Error('An end needs a reason.');
  const result = await pool.query<EndRow>(
    `INSERT INTO remote_agent_item_ends
       (item_id, reason, by_declared, by_user_id, via, from_run_id, from_node_path, created_at,
        run_id, run_completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${latestRun('id')}, ${latestRun('completed_at')})
     RETURNING *`,
    [input.itemId, input.reason, ...actColumns(input)]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('The end was not written');
  const read = endRead(row);
  if ('type' in read) throw new Error(`End '${row.id}' was written but does not read back`);
  return read;
}

/**
 * The newest end on item `itemId` that still holds, or null. An end that recorded no run
 * holds while the item still has none.
 */
export async function getHoldingItemEnd(itemId: string): Promise<ItemEnd | ItemEndDegraded | null> {
  // Null-safe equality: an end that recorded no run matches an item that has none.
  const sameAs = getDatabaseType() === 'sqlite' ? 'IS' : 'IS NOT DISTINCT FROM';
  const result = await pool.query<EndRow>(
    `SELECT e.* FROM remote_agent_item_ends e
     WHERE e.item_id = $1
       AND e.run_id ${sameAs} ${latestRun('id')}
       AND e.run_completed_at ${sameAs} ${latestRun('completed_at')}
     ORDER BY e.seq DESC LIMIT 1`,
    [itemId]
  );
  const row = result.rows[0];
  return row === undefined ? null : endRead(row);
}
