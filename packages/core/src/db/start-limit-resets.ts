/**
 * When a binding's start limit on an item last reset (see `@archon/workflows/start-limit`).
 * The completing write records the completion of a run on an item that already has a
 * start limit or a grant, so a later cleanup of that run cannot bring earlier rounds
 * back. An item with neither has nothing to reset: every start on it comes after.
 */
import type { TransactionQuery as Query } from './resource-slots';
import { toHydratedTimestamp } from './timestamps';

/** Record the completion of run `runId` as a reset, inside the transaction that completes it. */
export async function recordStartLimitReset(query: Query, runId: string): Promise<void> {
  await query(
    `INSERT INTO remote_agent_start_limit_resets (item_id, workflow_name, reset_at)
     SELECT r.item_id, r.workflow_name, r.completed_at FROM remote_agent_workflow_runs r
      WHERE r.id = $1 AND r.item_id IS NOT NULL AND r.completed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM remote_agent_resource_start_requests q
                     WHERE q.item_id = r.item_id
                       AND (q.start_limit IS NOT NULL OR q.grants_limit IS NOT NULL))`,
    [runId]
  );
}

/**
 * The latest completion of `workflow` on the item, from the recorded resets and from the
 * runs still present (a completion an older binary wrote records no reset), or null.
 */
export async function lastStartLimitReset(
  query: Query,
  itemId: string,
  workflow: string | undefined
): Promise<string | null> {
  if (workflow === undefined) return null;
  const found = await query<{ at: string | Date | null }>(
    `SELECT MAX(reset_at) AS at FROM remote_agent_start_limit_resets
      WHERE item_id = $1 AND workflow_name = $2
     UNION ALL
     SELECT MAX(completed_at) AS at FROM remote_agent_workflow_runs
      WHERE item_id = $1 AND workflow_name = $2 AND status = 'completed'`,
    [itemId, workflow]
  );
  let latest: number | null = null;
  for (const { at } of found.rows) {
    if (at == null) continue;
    const time = toHydratedTimestamp(at).getTime();
    if (latest === null || time > latest) latest = time;
  }
  return latest === null ? null : new Date(latest).toISOString();
}
