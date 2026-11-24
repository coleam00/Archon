/**
 * The start requests the item read lists beside an item's runs: its queued and its refused
 * (`skipped`) starts. Each reads a whole page of items in one statement, through the
 * `(item_id, status)` index on the requests table.
 */
import { z } from 'zod';
import type { SkippedItemStart } from '@archon/workflows/resource-start-store';
import type { QueuedItemStart } from '@archon/workflows/schemas/resource-start';
import { getDatabase } from './connection';
import { parseStoredJson } from './resource-starts';
import { toHydratedTimestamp } from './timestamps';

/** `$1, $2, ...`, one for each of `values`. */
function placeholderList(values: readonly unknown[]): string {
  return values.map((_, index) => `$${String(index + 1)}`).join(', ');
}

/** An empty list for each of `ids`, keyed in order. */
function emptyListsFor<T>(ids: readonly string[]): Map<string, T[]> {
  return new Map(ids.map(id => [id, []]));
}

/** The skipped starts of `count` items, `$1..$count` their ids. Named so a test can plan it. */
export function skippedItemStartsSqlFor(count: number): string {
  return `SELECT item_id, id, resource_key, blocker_kind, blocker_run_id, launch
       FROM remote_agent_resource_start_requests
      WHERE item_id IN (${placeholderList(Array.from({ length: count }))}) AND status = 'skipped'
      ORDER BY queue_position`;
}

/** The queued starts of `count` items, `$1..$count` their ids. Named so a test can plan it. */
export function queuedItemStartsSqlFor(count: number): string {
  return `SELECT r.item_id, r.id, r.resource_key, r.host_id, r.launch, r.created_at,
       (SELECT COUNT(*) FROM remote_agent_resource_start_requests q
         WHERE q.resource_key = r.resource_key AND q.host_id = r.host_id
           AND q.status = 'queued' AND q.queue_position < r.queue_position) AS ahead
       FROM remote_agent_resource_start_requests r
      WHERE r.item_id IN (${placeholderList(Array.from({ length: count }))}) AND r.status = 'queued'
      ORDER BY r.queue_position`;
}

export async function listSkippedItemStarts(
  itemIds: readonly string[]
): Promise<ReadonlyMap<string, SkippedItemStart[]>> {
  const byItem = emptyListsFor<SkippedItemStart>(itemIds);
  if (byItem.size === 0) return byItem;
  const ids = [...byItem.keys()];
  const result = await getDatabase().query<{
    item_id: string;
    id: string;
    resource_key: string;
    blocker_kind: string | null;
    blocker_run_id: string | null;
    launch: unknown;
  }>(skippedItemStartsSqlFor(ids.length), ids);
  for (const row of result.rows)
    byItem.get(row.item_id)?.push({
      requestId: row.id,
      workflow: storedWorkflowName(row.launch),
      resource: row.resource_key,
      blockerRunId: row.blocker_kind === 'run' ? row.blocker_run_id : null,
    });
  return byItem;
}

const storedWorkflowNameSchema = z.object({ run: z.object({ workflow_name: z.string() }) });

/** The launch's workflow name, or null when the stored launch does not read. */
export function storedWorkflowName(launch: unknown): string | null {
  try {
    const parsed = storedWorkflowNameSchema.safeParse(parseStoredJson(launch));
    return parsed.success ? parsed.data.run.workflow_name : null;
  } catch {
    // Malformed JSON: the item read reports the start without its workflow.
    return null;
  }
}

export async function listQueuedItemStarts(
  itemIds: readonly string[]
): Promise<ReadonlyMap<string, QueuedItemStart[]>> {
  const byItem = emptyListsFor<QueuedItemStart>(itemIds);
  if (byItem.size === 0) return byItem;
  const ids = [...byItem.keys()];
  const result = await getDatabase().query<{
    item_id: string;
    id: string;
    resource_key: string;
    host_id: string;
    launch: unknown;
    created_at: string | Date;
    ahead: number | string;
  }>(queuedItemStartsSqlFor(ids.length), ids);
  for (const row of result.rows)
    byItem.get(row.item_id)?.push({
      requestId: row.id,
      workflow: storedWorkflowName(row.launch),
      resource: row.resource_key,
      hostId: row.host_id,
      queuedAt: toHydratedTimestamp(row.created_at).toISOString(),
      // Postgres returns COUNT(*) as a string.
      ahead: Number(row.ahead),
    });
  return byItem;
}
