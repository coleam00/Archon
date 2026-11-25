/**
 * Queued requests whose stored launch does not read. Admission keeps queue order, so each
 * holds every request behind it on its resource and host until it is withdrawn.
 */
import type { UnreadableQueuedStart } from '@archon/workflows/resource-start-store';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import { preparedWorkflowLaunchSchema } from '@archon/workflows/schemas/resource-start';
import { getDatabase } from './connection';
import { toHydratedTimestamp } from './timestamps';

/** A stored launch, or null when it does not read: a request can be withdrawn either way. */
export function readableLaunch(stored: unknown): PreparedWorkflowLaunch | null {
  try {
    const parsed = preparedWorkflowLaunchSchema.safeParse(
      typeof stored === 'string' ? JSON.parse(stored) : stored
    );
    return parsed.success ? parsed.data : null;
  } catch {
    // Malformed JSON reads as no launch, the same as one that fails its schema.
    return null;
  }
}

/** See `IResourceStartStore.listUnreadableQueuedStarts`. */
export async function listUnreadableQueuedStarts(): Promise<UnreadableQueuedStart[]> {
  return (await unreadableQueued()).map(({ position: _position, ...start }) => start);
}

/** The queued requests whose launch does not read, each with its queue position. */
export async function unreadableQueued(): Promise<
  (UnreadableQueuedStart & { position: number })[]
> {
  const result = await getDatabase().query<{
    id: string;
    resource_key: string;
    host_id: string;
    item_id: string | null;
    launch: unknown;
    created_at: string | Date;
    queue_position: number | string;
    behind: number | string;
  }>(
    `SELECT r.id, r.resource_key, r.host_id, r.item_id, r.launch, r.created_at, r.queue_position,
            (SELECT COUNT(*) FROM remote_agent_resource_start_requests q
              WHERE q.resource_key = r.resource_key AND q.host_id = r.host_id
                AND q.status = 'queued' AND q.queue_position > r.queue_position) AS behind
       FROM remote_agent_resource_start_requests r
      WHERE r.status = 'queued'
      ORDER BY r.queue_position`
  );
  return result.rows
    .filter(row => readableLaunch(row.launch) === null)
    .map(row => ({
      requestId: String(row.id),
      resource: row.resource_key,
      hostId: row.host_id,
      itemId: row.item_id === null ? null : String(row.item_id),
      queuedAt: toHydratedTimestamp(row.created_at).toISOString(),
      // Postgres returns COUNT(*) and BIGSERIAL as strings.
      behind: Number(row.behind),
      position: Number(row.queue_position),
    }));
}
