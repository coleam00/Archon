/**
 * Keyed resource slots: a durable counting lock with typed holders.
 *
 * A slot admits up to `capacity` live holders. Callers run these helpers inside one
 * database transaction, lock the slot first, then decide. A holder is released when
 * the thing it names reaches a terminal state; release is read from that authoritative
 * state inside the slot lock, never from elapsed time, so a live holder is never
 * declared dead. Waiters and their FIFO order belong to the caller, because a waiter
 * carries the caller's own payload (a start request carries its prepared launch).
 *
 * Holder kinds and their liveness:
 * - `run`: a workflow run, live until the run is terminal or gone.
 * - `attempt`: one provider attempt, released by its owner when the provider stream
 *   has closed, or here when its owner process is provably gone (`process-owner.ts`).
 */
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDatabaseType } from './connection';
import { isOwnerProvablyGone, type ProcessOwner } from './process-owner';

export type TransactionQuery = Parameters<
  Parameters<ReturnType<typeof getDatabase>['withTransaction']>[0]
>[0];

/** A new kind adds its liveness rule to `liveResourceSlotHolders`. */
export type ResourceSlotHolder =
  | { kind: 'run'; id: string }
  | { kind: 'attempt'; id: string; owner: ProcessOwner };

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

/**
 * Lock a slot whose capacity the operator configures (a provider cap), writing the
 * current configured capacity. The upsert takes the same locks as `lockResourceSlot`.
 * Lowering the capacity never removes a holder; it only blocks new admissions.
 */
export async function lockConfiguredResourceSlot(
  query: TransactionQuery,
  resource: string,
  capacity: number
): Promise<void> {
  await query(
    `INSERT INTO remote_agent_resource_slots (resource_key, capacity) VALUES ($1, $2)
       ON CONFLICT(resource_key) DO UPDATE SET capacity = excluded.capacity`,
    [resource, capacity]
  );
}

/** Release holders whose run ended or whose owner process is provably gone, then return the live ones, oldest first. */
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
  const rows = await query<HolderRow>(
    `SELECT holder_kind, holder_id, owner_host, owner_pid, owner_instance
       FROM remote_agent_resource_slot_holders
      WHERE resource_key = $1 ORDER BY acquired_at, holder_id`,
    [resource]
  );
  const live: ResourceSlotHolder[] = [];
  for (const row of rows.rows) {
    const holder = holderFromRow(row);
    if (holder.kind === 'attempt' && isOwnerProvablyGone(holder.owner)) {
      await removeResourceSlotHolder(query, resource, holder);
      continue;
    }
    live.push(holder);
  }
  return live;
}

interface HolderRow {
  holder_kind: string;
  holder_id: string;
  owner_host: string | null;
  owner_pid: number | string | null;
  owner_instance: string | null;
}

function holderFromRow(row: HolderRow): ResourceSlotHolder {
  if (row.holder_kind === 'run') return { kind: 'run', id: row.holder_id };
  if (
    row.holder_kind === 'attempt' &&
    row.owner_host !== null &&
    row.owner_pid !== null &&
    row.owner_instance !== null
  ) {
    return {
      kind: 'attempt',
      id: row.holder_id,
      owner: { host: row.owner_host, pid: Number(row.owner_pid), instance: row.owner_instance },
    };
  }
  throw new Error(
    `Resource slot holder '${row.holder_id}' has kind '${row.holder_kind}' without a complete owner`
  );
}

export async function addResourceSlotHolder(
  query: TransactionQuery,
  resource: string,
  holder: ResourceSlotHolder
): Promise<void> {
  const owner = holder.kind === 'attempt' ? holder.owner : null;
  await query(
    `INSERT INTO remote_agent_resource_slot_holders
       (resource_key, holder_kind, holder_id, owner_host, owner_pid, owner_instance)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [
      resource,
      holder.kind,
      holder.id,
      owner?.host ?? null,
      owner?.pid ?? null,
      owner?.instance ?? null,
    ]
  );
}

/** Returns whether a holder row was removed. */
export async function removeResourceSlotHolder(
  query: TransactionQuery,
  resource: string,
  holder: Pick<ResourceSlotHolder, 'kind' | 'id'>
): Promise<boolean> {
  const result = await query(
    `DELETE FROM remote_agent_resource_slot_holders
      WHERE resource_key = $1 AND holder_kind = $2 AND holder_id = $3`,
    [resource, holder.kind, holder.id]
  );
  return result.rowCount > 0;
}
