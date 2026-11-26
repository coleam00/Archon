/**
 * Item priority (`remote_agent_item_priorities`): a row means the item has its own priority,
 * and every item `part_of` it through active links, at any depth, has it too. This module
 * owns the rule and the queue order it gives: every query that orders or compares queued
 * start requests ranks them through `queueRankSql`, so the drain, a new start's place and
 * every report of what is ahead agree. `queue_position` on the requests is never rewritten,
 * so an older binary sharing the database still admits in its own order.
 */
import type {
  ItemPriority,
  ItemPriorityReport,
  ItemPriorityTarget,
} from '@archon/workflows/schemas/item-priority';
import { getDatabase, pool } from './connection';
import { ensureItemInProject } from './items';
import type { TransactionQuery } from './resource-slots';

/**
 * `prio(item_id, source_id)`: every item with priority and each item whose own row gives it.
 * For a `WITH RECURSIVE` clause. Links are operator data and may form a cycle; `UNION` ends
 * the recursion there, since the pairs are finite.
 */
export const PRIORITY_ITEMS_CTE = `prio(item_id, source_id) AS (
  SELECT item_id, item_id FROM remote_agent_item_priorities
  UNION
  SELECT l.from_item_id, p.source_id FROM remote_agent_item_links l
    JOIN prio p ON l.to_item_id = p.item_id
   WHERE l.kind = 'part_of' AND l.ended_at IS NULL)`;

/** A queued request's rank under `PRIORITY_ITEMS_CTE`: 0 on an item with priority, else 1. */
export function queueRankSql(alias: string): string {
  return `(CASE WHEN ${alias}.item_id IN (SELECT item_id FROM prio) THEN 0 ELSE 1 END)`;
}

/** The queue order of requests aliased `alias`: rank, then first in, first out. */
export function queueOrderSql(alias: string): string {
  return `${queueRankSql(alias)}, ${alias}.queue_position`;
}

/** Request `a` is ahead of request `b` in queue order. */
export function queuedAheadSql(a: string, b: string): string {
  return `(${queueRankSql(a)} < ${queueRankSql(b)} OR (${queueRankSql(a)} = ${queueRankSql(b)} AND ${a}.queue_position < ${b}.queue_position))`;
}

/** A queued request's place, as `queueRankSql` and `queue_position` read it. */
export interface QueuePlace {
  rank: number;
  position: number;
}

/** `queuedAheadSql` for two places already read. */
export function isQueuedAhead(a: QueuePlace, b: QueuePlace): boolean {
  return a.rank < b.rank || (a.rank === b.rank && a.position < b.position);
}

/** The items with priority, own or inherited. */
export async function readPriorityItems(query: TransactionQuery): Promise<Set<string>> {
  const rows = await query<{ item_id: string }>(
    `WITH RECURSIVE ${PRIORITY_ITEMS_CTE} SELECT DISTINCT item_id FROM prio`
  );
  return new Set(rows.rows.map(row => String(row.item_id)));
}

async function readPriority(query: TransactionQuery, itemId: string): Promise<ItemPriority | null> {
  const rows = await query<{ id: string; project_key: string; key: string }>(
    `WITH RECURSIVE ${PRIORITY_ITEMS_CTE}
     SELECT DISTINCT i.id, i.project_key, i.key FROM prio p
       JOIN remote_agent_items i ON i.id = p.source_id
      WHERE p.item_id = $1
      ORDER BY i.key, i.id`,
    [itemId]
  );
  if (rows.rows.length === 0) return null;
  const sources = rows.rows.map(row => ({
    id: String(row.id),
    projectKey: row.project_key,
    key: row.key,
  }));
  return {
    own: sources.some(source => source.id === itemId),
    inheritedFrom: sources.filter(source => source.id !== itemId),
  };
}

export function getItemPriority(itemId: string): Promise<ItemPriority | null> {
  return readPriority(pool.query, itemId);
}

/** A work order is given priority before its members have runs, so the item is written on first use. */
export async function setItemPriority(input: ItemPriorityReport): Promise<ItemPriority> {
  return getDatabase().withTransaction(async query => {
    const itemId = await ensureItemInProject(query, input.projectKey, input.key);
    await query(
      `INSERT INTO remote_agent_item_priorities (item_id, from_run_id, from_node_path, recorded_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (item_id) DO UPDATE SET from_run_id = excluded.from_run_id,
         from_node_path = excluded.from_node_path, recorded_at = excluded.recorded_at`,
      [
        itemId,
        input.fromRun?.runId ?? null,
        input.fromRun?.nodePath ?? null,
        new Date().toISOString(),
      ]
    );
    const priority = await readPriority(query, itemId);
    if (priority === null)
      throw new Error(`The priority of item '${input.key}' was written but does not read back`);
    return priority;
  });
}

/**
 * Remove the item's own priority and return what it still has through the items it is
 * `part_of`. Null when the project has no item under the key; clearing never creates one.
 */
export async function clearItemPriority(
  input: ItemPriorityTarget
): Promise<{ priority: ItemPriority | null } | null> {
  return getDatabase().withTransaction(async query => {
    const item = (
      await query<{ id: string }>(
        'SELECT id FROM remote_agent_items WHERE project_key = $1 AND key = $2',
        [input.projectKey, input.key]
      )
    ).rows[0];
    if (!item) return null;
    const itemId = String(item.id);
    await query('DELETE FROM remote_agent_item_priorities WHERE item_id = $1', [itemId]);
    return { priority: await readPriority(query, itemId) };
  });
}
