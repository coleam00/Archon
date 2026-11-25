/**
 * The branch an item's change lands on (`remote_agent_item_landings`): one row per item.
 * Recording again replaces the row, so a mistyped branch is corrected by recording the
 * right one. A run already started keeps the base it recorded at its start.
 */
import {
  itemLandingSchema,
  type ItemLanding,
  type ItemLandingDegraded,
  type ItemLandingReport,
} from '@archon/workflows/schemas/item-landing';
import { getDatabase, pool } from './connection';
import { ensureItemInProject } from './items';
import type { TransactionQuery } from './resource-slots';
import { toHydratedTimestamp } from './timestamps';
import { getLog } from './workflow-run-shared';

interface LandingRow {
  item_id: string;
  branch: string;
  from_run_id: string | null;
  from_node_path: string | null;
  recorded_at: string | Date;
}

function landingRead(row: LandingRow): ItemLanding | ItemLandingDegraded {
  const time = toHydratedTimestamp(row.recorded_at);
  const parsed = itemLandingSchema.safeParse({
    branch: row.branch,
    recordedAt: Number.isNaN(time.getTime()) ? String(row.recorded_at) : time.toISOString(),
    fromRun:
      row.from_run_id === null
        ? null
        : { runId: row.from_run_id, nodePath: row.from_node_path ?? '' },
  });
  if (parsed.success) return parsed.data;
  getLog().error({ itemId: row.item_id }, 'item_landing_unreadable');
  return { type: 'degraded', reason: 'landing_unreadable', itemId: row.item_id };
}

async function readLanding(
  query: TransactionQuery,
  itemId: string
): Promise<ItemLanding | ItemLandingDegraded | null> {
  const result = await query<LandingRow>(
    'SELECT * FROM remote_agent_item_landings WHERE item_id = $1',
    [itemId]
  );
  const row = result.rows[0];
  return row ? landingRead(row) : null;
}

export function getItemLanding(itemId: string): Promise<ItemLanding | ItemLandingDegraded | null> {
  return readLanding(pool.query, itemId);
}

/** A work order records its branch before its members have runs, so the item is written on first use. */
export async function recordItemLanding(input: ItemLandingReport): Promise<ItemLanding> {
  return getDatabase().withTransaction(async query => {
    const itemId = await ensureItemInProject(query, input.projectKey, input.key);
    await query(
      `INSERT INTO remote_agent_item_landings
         (item_id, branch, from_run_id, from_node_path, recorded_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_id) DO UPDATE SET branch = excluded.branch,
         from_run_id = excluded.from_run_id, from_node_path = excluded.from_node_path,
         recorded_at = excluded.recorded_at`,
      [
        itemId,
        input.branch,
        input.fromRun?.runId ?? null,
        input.fromRun?.nodePath ?? null,
        new Date().toISOString(),
      ]
    );
    const landing = await readLanding(query, itemId);
    if (landing === null || 'type' in landing)
      throw new Error(
        `The landing branch of item '${input.key}' was written but does not read back`
      );
    return landing;
  });
}
