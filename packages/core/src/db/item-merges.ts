/**
 * An item's merged fact (`remote_agent_item_merges`): one row per item, written once and
 * never updated. The engine stores what the caller reports and never parses `change`.
 */
import {
  itemMergeSchema,
  type ItemMerge,
  type ItemMergeDegraded,
  type ItemMergeRecorded,
  type ItemMergeReport,
} from '@archon/workflows/schemas/item-merge';
import { getDatabase, pool } from './connection';
import type { TransactionQuery } from './resource-slots';
import { toHydratedTimestamp } from './timestamps';
import { getLog } from './workflow-run-shared';

interface MergeRow {
  item_id: string;
  change: string;
  merge_commit: string | null;
  merged_at: string | Date;
  via: string;
  from_run_id: string | null;
  from_node_path: string | null;
  created_at: string | Date;
}

function isoTime(value: string | Date): string {
  const time = toHydratedTimestamp(value);
  return Number.isNaN(time.getTime()) ? String(value) : time.toISOString();
}

function mergeRead(row: MergeRow): ItemMerge | ItemMergeDegraded {
  const parsed = itemMergeSchema.safeParse({
    change: row.change,
    commit: row.merge_commit,
    at: isoTime(row.merged_at),
    recordedAt: isoTime(row.created_at),
    via: row.via,
    fromRun:
      row.from_run_id === null
        ? null
        : { runId: row.from_run_id, nodePath: row.from_node_path ?? '' },
  });
  if (parsed.success) return parsed.data;
  getLog().error({ itemId: row.item_id }, 'item_merge_unreadable');
  return { type: 'degraded', reason: 'merge_unreadable', itemId: row.item_id };
}

async function readMerge(
  query: TransactionQuery,
  itemId: string
): Promise<ItemMerge | ItemMergeDegraded | null> {
  const result = await query<MergeRow>(
    'SELECT * FROM remote_agent_item_merges WHERE item_id = $1',
    [itemId]
  );
  const row = result.rows[0];
  return row ? mergeRead(row) : null;
}

export function getItemMerge(itemId: string): Promise<ItemMerge | ItemMergeDegraded | null> {
  return readMerge(pool.query, itemId);
}

/** Null when the project has no item under the key: a merge never creates an item. */
export async function recordItemMerge(input: ItemMergeReport): Promise<ItemMergeRecorded | null> {
  return getDatabase().withTransaction(async query => {
    const found = await query<{ id: string }>(
      'SELECT id FROM remote_agent_items WHERE project_key = $1 AND key = $2',
      [input.projectKey, input.key]
    );
    const itemId = found.rows[0]?.id;
    if (itemId === undefined) return null;
    const inserted = await query(
      `INSERT INTO remote_agent_item_merges
         (item_id, change, merge_commit, merged_at, via, from_run_id, from_node_path, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (item_id) DO NOTHING`,
      [
        itemId,
        input.change,
        input.commit,
        new Date(input.at).toISOString(),
        input.via,
        input.fromRun?.runId ?? null,
        input.fromRun?.nodePath ?? null,
        new Date().toISOString(),
      ]
    );
    const merge = await readMerge(query, itemId);
    if (merge === null || 'type' in merge)
      throw new Error(`The merge of item '${input.key}' was written but does not read back`);
    return { merge, recorded: inserted.rowCount === 1 };
  });
}
