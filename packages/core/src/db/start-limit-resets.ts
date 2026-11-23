/**
 * Where a binding's start limit on an item last reset (see `@archon/workflows/start-limit`).
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
import type { StartLimitReset } from '@archon/workflows/start-limit';
import { lockAdmission, type TransactionQuery as Query } from './resource-slots';
import { toHydratedTimestamp } from './timestamps';

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
  const ids = typeof row.queued_ids === 'string' ? JSON.parse(row.queued_ids) : row.queued_ids;
  return {
    at: toHydratedTimestamp(row.reset_at).toISOString(),
    afterPosition: Number(row.after_position),
    queuedIds: queuedIdsSchema.parse(ids),
  };
}
