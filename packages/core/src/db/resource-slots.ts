/**
 * Keyed resource slots: a durable counting lock with typed holders.
 *
 * A slot admits up to `capacity` live holders. Callers run these helpers inside one
 * database transaction, lock the slot first, then decide. A holder is released when
 * the thing it names reaches a terminal state; release is read from that authoritative
 * state inside the slot lock, never from elapsed time, so a live holder is never
 * declared dead. Waiters and their FIFO order belong to the caller, because a waiter
 * carries the caller's own payload (a start request carries its prepared launch).
 */
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDatabaseType } from './connection';

export type TransactionQuery = Parameters<
  Parameters<ReturnType<typeof getDatabase>['withTransaction']>[0]
>[0];

/** The only holder kind today. A new kind adds its liveness rule to `liveResourceSlotHolders`. */
export interface ResourceSlotHolder {
  kind: 'run';
  id: string;
}

export class ResourceSlotCapacityConflictError extends Error {
  constructor(
    public readonly resource: string,
    public readonly configured: number,
    public readonly requested: number
  ) {
    super(
      `Resource '${resource}' has capacity ${String(configured)}; a request declared ${String(requested)}. Every binding for one resource must declare the same capacity.`
    );
    this.name = 'ResourceSlotCapacityConflictError';
  }
}

const terminalList = TERMINAL_WORKFLOW_STATUSES.map(status => `'${status}'`).join(', ');

/**
 * Create the slot if needed and take its lock for the rest of the transaction.
 * A `requestedCapacity` that differs from the stored one fails instead of picking one.
 */
export async function lockResourceSlot(
  query: TransactionQuery,
  resource: string,
  requestedCapacity?: number
): Promise<{ capacity: number }> {
  await query(
    `INSERT INTO remote_agent_resource_slots (resource_key, capacity) VALUES ($1, $2)
       ON CONFLICT(resource_key) DO NOTHING`,
    [resource, requestedCapacity ?? 1]
  );
  // A no-op write takes SQLite's writer lock and PostgreSQL's row lock before any read.
  await query(
    'UPDATE remote_agent_resource_slots SET resource_key = resource_key WHERE resource_key = $1',
    [resource]
  );
  const slot = await query<{ capacity: number | string }>(
    'SELECT capacity FROM remote_agent_resource_slots WHERE resource_key = $1',
    [resource]
  );
  const capacity = Number(slot.rows[0]?.capacity ?? 1);
  if (requestedCapacity !== undefined && requestedCapacity !== capacity) {
    throw new ResourceSlotCapacityConflictError(resource, capacity, requestedCapacity);
  }
  return { capacity };
}

/** Release holders whose run ended or disappeared, then return the live ones, oldest first. */
export async function liveResourceSlotHolders(
  query: TransactionQuery,
  resource: string
): Promise<ResourceSlotHolder[]> {
  // This runs on every scheduler tick against the ever-growing runs table, so the
  // run side stays a bare column its primary key can serve. Postgres types the run
  // ID as UUID, so the text holder ID is cast instead; SQLite stores both as text,
  // and has no UUID type to cast to.
  const holderRunId =
    getDatabaseType() === 'postgresql'
      ? 'CAST(remote_agent_resource_slot_holders.holder_id AS UUID)'
      : 'remote_agent_resource_slot_holders.holder_id';
  await query(
    `DELETE FROM remote_agent_resource_slot_holders
      WHERE resource_key = $1 AND holder_kind = 'run'
        AND NOT EXISTS (
          SELECT 1 FROM remote_agent_workflow_runs w
           WHERE w.id = ${holderRunId}
             AND w.status NOT IN (${terminalList})
        )`,
    [resource]
  );
  const holders = await query<{ holder_kind: 'run'; holder_id: string }>(
    `SELECT holder_kind, holder_id FROM remote_agent_resource_slot_holders
      WHERE resource_key = $1 ORDER BY acquired_at, holder_id`,
    [resource]
  );
  return holders.rows.map(row => ({ kind: row.holder_kind, id: row.holder_id }));
}

export async function addResourceSlotHolder(
  query: TransactionQuery,
  resource: string,
  holder: ResourceSlotHolder
): Promise<void> {
  await query(
    `INSERT INTO remote_agent_resource_slot_holders (resource_key, holder_kind, holder_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [resource, holder.kind, holder.id]
  );
}
