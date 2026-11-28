/**
 * Queued requests whose stored launch does not read. Admission keeps queue order
 * (`queueOrderSql`), so each holds every request behind it on its resource and host until
 * it is withdrawn.
 */
import type { UnreadableQueuedStart } from '@archon/workflows/resource-start-store';
import type { PreparedWorkflowLaunch } from '@archon/workflows/schemas/resource-start';
import { preparedWorkflowLaunchSchema } from '@archon/workflows/schemas/resource-start';
import { getDatabase } from './connection';
import { toHydratedTimestamp } from './timestamps';
import {
  PRIORITY_ITEMS_CTE,
  queuedAheadSql,
  queueOrderSql,
  queueRankSql,
  type QueuePlace,
} from './item-priorities';

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
  return (await unreadableQueued()).map(({ rank: _rank, position: _position, ...start }) => start);
}

/** The queued requests whose launch does not read, each with its place in queue order. */
export async function unreadableQueued(): Promise<(UnreadableQueuedStart & QueuePlace)[]> {
  const result = await getDatabase().query<{
    id: string;
    resource_key: string;
    host_id: string;
    item_id: string | null;
    launch: unknown;
    created_at: string | Date;
    queue_position: number | string;
    queue_rank: number | string;
    behind: number | string;
  }>(
    `WITH RECURSIVE ${PRIORITY_ITEMS_CTE}
     SELECT r.id, r.resource_key, r.host_id, r.item_id, r.launch, r.created_at, r.queue_position,
            ${queueRankSql('r')} AS queue_rank,
            (SELECT COUNT(*) FROM remote_agent_resource_start_requests q
              WHERE q.resource_key = r.resource_key AND q.host_id = r.host_id
                AND q.status = 'queued' AND ${queuedAheadSql('r', 'q')}) AS behind
       FROM remote_agent_resource_start_requests r
      WHERE r.status = 'queued'
      ORDER BY ${queueOrderSql('r')}`
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
      rank: Number(row.queue_rank),
      position: Number(row.queue_position),
    }));
}
