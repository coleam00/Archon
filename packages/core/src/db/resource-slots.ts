import { z } from 'zod';
import { activeWorkflowPathHolderCondition } from './workflow-run-reads';
import {
  ResourceSlotCapacityConflictError,
  capacityWaiters,
  heldCheckouts,
  type ReusableCheckout,
  type ResourceSlotOccupancy,
  type QueuedStart,
} from '@archon/workflows/resource-start-store';
import {
  preparedWorkflowLaunchSchema,
  type PreparedWorkflowLaunch,
} from '@archon/workflows/schemas/resource-start';
/**
 * Keyed resource slots: a durable counting lock with typed holders.
 *
 * A slot admits up to `capacity` live holders. Callers run these helpers inside one
 * database transaction, lock the slot first, then decide. A holder is released when
 * the thing it names reaches a terminal state, or explicitly by its owner; release is
 * read from authoritative state inside the slot lock, never from elapsed time, so a
 * live holder is never declared dead. Waiters and their FIFO order belong to the
 * caller, because a waiter carries the caller's own payload (a start request carries
 * its prepared launch, a capacity waiter is a paused run).
 *
 * Holder kinds and their liveness:
 * - `run`: a workflow run, live until the run is terminal or gone, or until the run,
 *   paused at a pause `continuablePauseCursor` names, gives its slot back
 *   (`releasePausedRunSlot`). A run released for an unreadable source keeps it.
 * - `attempt`: one provider attempt, released by its owner when the provider stream
 *   has closed, or here when its owner process is provably gone (`@archon/paths/process-owner`).
 */
import {
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import { getDatabase, getDatabaseType, getDialect } from './connection';
import { parseJsonObject } from './workflow-run-normalization';
import { getLog } from './workflow-run-shared';
import {
  isOwnerProvablyGone,
  parseProcessOwner,
  type ProcessOwner,
} from '@archon/paths/process-owner';

export type TransactionQuery = Parameters<
  Parameters<ReturnType<typeof getDatabase>['withTransaction']>[0]
>[0];

/** A new kind adds its liveness rule to `liveResourceSlotHolders`. */
export type ResourceSlotHolder =
  | { kind: 'run'; id: string }
  | { kind: 'attempt'; id: string; owner: ProcessOwner };

export { ResourceSlotCapacityConflictError } from '@archon/workflows/resource-start-store';

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
    const holder = holderFromRow(resource, row);
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
  owner_pid: number | null;
  owner_instance: string | null;
}

function holderFromRow(resource: string, row: HolderRow): ResourceSlotHolder {
  if (row.holder_kind === 'run') return { kind: 'run', id: row.holder_id };
  if (row.holder_kind === 'attempt') {
    return {
      kind: 'attempt',
      id: row.holder_id,
      owner: parseProcessOwner(
        { host: row.owner_host, pid: row.owner_pid, instance: row.owner_instance },
        resourceSlotHolderSource(resource, row.holder_id)
      ),
    };
  }
  throw new Error(`Resource slot holder '${row.holder_id}' has unknown kind '${row.holder_kind}'`);
}

/** Names a holder row in a `ProcessOwnerRecordError`. */
export function resourceSlotHolderSource(resource: string, holderId: string): string {
  return `resource slot '${resource}' holder '${holderId}'`;
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

/**
 * What a run-start slot holds, read under its lock (`lockResourceSlot`): live holders,
 * capacity waiters, the checkouts live admitted runs hold, and the queued start requests. The
 * queued rows are locked too, so a concurrent withdrawal cannot race their admission.
 */
export async function resourceStartOccupancy(
  query: TransactionQuery,
  resource: string,
  capacity: number
): Promise<ResourceSlotOccupancy> {
  const holders = await liveResourceSlotHolders(query, resource);
  const holding = new Set(holders.filter(holder => holder.kind === 'run').map(holder => holder.id));
  const live = await query<{
    id: string;
    status: WorkflowRunStatus;
    metadata: unknown;
    working_path: string | null;
    launch: unknown;
    resource_key: string | null;
    foreign_membership: boolean | number;
    holds_path: boolean | number;
  }>(
    `SELECT w.id, w.status, w.metadata, w.working_path, q.launch, q.resource_key, w.holds_path,
       EXISTS (
         SELECT 1 FROM remote_agent_resource_slot_holders h
          WHERE h.holder_kind = 'run' AND h.holder_id = CAST(w.id AS TEXT)
            AND h.resource_key <> $1
       ) AS foreign_membership
       FROM (
         SELECT *, ${activeWorkflowPathHolderCondition()} AS holds_path FROM remote_agent_workflow_runs
       ) w
       LEFT JOIN remote_agent_resource_start_requests q ON q.id = w.id AND q.status = 'admitted'
      WHERE w.status NOT IN (${terminalList})
        AND (q.resource_key = $1 OR w.holds_path OR EXISTS (
          SELECT 1 FROM remote_agent_resource_slot_holders h
           WHERE h.resource_key = $1 AND h.holder_kind = 'run' AND h.holder_id = CAST(w.id AS TEXT)
        ))
      ORDER BY w.started_at, w.id`,
    [resource]
  );
  const queued = await query<Record<string, unknown>>(
    `SELECT id, host_id, resource_key, status, launch FROM remote_agent_resource_start_requests
      WHERE resource_key = $1 AND status = 'queued'
      ORDER BY queue_position${getDialect().rowLock()}`,
    [resource]
  );
  const isLocal = (row: (typeof live.rows)[number]) =>
    holding.has(String(row.id)) || (!row.foreign_membership && row.resource_key === resource);
  const liveRuns = live.rows.filter(isLocal).map(row => {
    if (row.resource_key !== resource)
      throw new Error(`Resource '${resource}' holder '${row.id}' has no matching admitted request`);
    return {
      id: String(row.id),
      status: row.status,
      metadata: parseJsonObject(row.metadata) ?? {},
      working_path: row.working_path,
      launch: parseLaunch(row.launch),
    };
  });
  const reusable = await query<ReusableCheckout>(
    `SELECT codebase_id AS "codebaseId", workflow_id AS branch, working_path AS "workingPath"
       FROM remote_agent_isolation_environments WHERE status = 'active' AND workflow_type = 'task'`
  );
  let unknownForeignCheckoutHolder: string | undefined;
  const foreign = live.rows
    .filter(row => !isLocal(row) && row.holds_path)
    .map(row => {
      const run = { id: String(row.id), working_path: row.working_path };
      if (row.launch === null) {
        if (row.foreign_membership && !row.working_path) {
          getLog().error({ runId: run.id }, 'db.foreign_launch_missing_checkout_unknown');
          unknownForeignCheckoutHolder ??= run.id;
        }
        return run;
      }
      try {
        return { ...run, launch: parseLaunch(row.launch) };
      } catch {
        // A known execution path still identifies the held checkout and its registered
        // aliases when a foreign launch is corrupt. Never guess without that path.
        if (row.working_path) {
          getLog().error({ runId: run.id }, 'db.foreign_launch_invalid_using_working_path');
          return run;
        }
        getLog().error({ runId: run.id }, 'db.foreign_launch_invalid_checkout_unknown');
        unknownForeignCheckoutHolder ??= run.id;
        return run;
      }
    });
  const queue: QueuedStart[] = [];
  let queueError: Error | undefined;
  for (const row of queued.rows) {
    try {
      queue.push(parseQueuedResourceStart(row, resource));
    } catch (error) {
      if (!(error instanceof z.ZodError || error instanceof SyntaxError)) throw error;
      queueError = new Error(`Invalid queued request '${String(row.id)}'`, { cause: error });
      getLog().error(
        { requestId: row.id, err: queueError },
        'db.queued_request_invalid_drain_prefix_only'
      );
      break;
    }
  }
  return {
    capacity,
    reusableCheckouts: reusable.rows,
    holders,
    waiters: capacityWaiters(liveRuns.filter(run => !holding.has(run.id))),
    queue,
    queueError,
    heldCheckouts: heldCheckouts(liveRuns, reusable.rows),
    foreignHeldCheckouts: heldCheckouts(foreign, reusable.rows),
    unknownForeignCheckoutHolder,
  };
}

function parseLaunch(value: unknown): PreparedWorkflowLaunch {
  return preparedWorkflowLaunchSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
}

const queuedResourceStartSchema = z
  .object({
    id: z.string().min(1),
    host_id: z.string().min(1),
    resource_key: z.string().min(1),
    status: z.literal('queued'),
    launch: z.preprocess(
      value => (typeof value === 'string' ? JSON.parse(value) : value),
      preparedWorkflowLaunchSchema
    ),
  })
  .refine(row => row.id === row.launch.run.id, {
    message: 'Queued request and launch run IDs disagree',
  });

export function parseQueuedResourceStart(value: unknown, resource?: string) {
  const row = queuedResourceStartSchema.parse(value);
  if (resource !== undefined && row.resource_key !== resource)
    throw new Error(`Queued request '${row.id}' does not belong to resource '${resource}'`);
  return { id: row.id, hostId: row.host_id, launch: row.launch };
}
