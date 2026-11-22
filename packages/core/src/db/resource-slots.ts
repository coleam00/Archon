import { z } from 'zod';
import { activeWorkflowPathHolderCondition } from './workflow-run-reads';
import {
  capacityWaiters,
  drainableStarts,
  recordedResourceCapacity,
  resourceStartBlocker,
  heldCheckouts,
  type ReusableCheckout,
  type ResourceBlocker,
  type ResourceSlotOccupancy,
  type QueuedStart,
} from '@archon/workflows/resource-start-store';
import {
  preparedWorkflowLaunchSchema,
  type InstallHold,
  type PreparedWorkflowLaunch,
} from '@archon/workflows/schemas/resource-start';
import type { RunLimit } from '@archon/workflows/schemas/run-limit';
import { itemHolder, itemHolders, type ItemRunRow } from '@archon/workflows/item-hold';
import { InstallHeldError, RunLimitError, WorkflowItemHeldError } from '@archon/workflows/store';
import { toHydratedTimestamp } from './timestamps';
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
import { loadResourceCapacities, loadRunLimit } from '../config/concurrency-config';
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

const terminalList = TERMINAL_WORKFLOW_STATUSES.map(status => `'${status}'`).join(', ');

/**
 * Serialize admission decisions for the rest of the transaction. Different resource rows
 * can reserve the same checkout, and starts of one workflow on one item can name different
 * resources, so one lock covers every slot. SQLite already serializes writers, and replays
 * a transaction whose read snapshot went stale before it wrote.
 */
export async function lockAdmission(query: TransactionQuery): Promise<void> {
  if (getDatabaseType() === 'postgresql') await query('SELECT pg_advisory_xact_lock(1797)');
}

/**
 * Non-terminal top-level runs on an item, oldest first, for the item rule (`itemHolders`).
 * `itemId` narrows to one item. Read under `lockAdmission`.
 */
export async function liveItemRuns(
  query: TransactionQuery,
  itemId?: string
): Promise<ItemRunRow[]> {
  const rows = await query<{
    id: string;
    workflow_name: string;
    item_id: string;
    status: WorkflowRunStatus;
    admitted: boolean | number;
  }>(
    `SELECT w.id, w.workflow_name, w.item_id, w.status,
       EXISTS (
         SELECT 1 FROM remote_agent_resource_start_requests q
          WHERE q.id = w.id AND q.status = 'admitted'
       ) AS admitted
       FROM remote_agent_workflow_runs w
      WHERE w.item_id IS NOT NULL AND w.parent_run_id IS NULL
        AND w.status NOT IN (${terminalList})${itemId === undefined ? '' : ' AND w.item_id = $1'}
      ORDER BY w.started_at, w.id`,
    itemId === undefined ? [] : [itemId]
  );
  return rows.rows.map(row => ({
    id: String(row.id),
    workflow_name: row.workflow_name,
    item_id: String(row.item_id),
    status: row.status,
    admitted: Boolean(row.admitted),
  }));
}

/**
 * The refusal for claiming or resuming `runId` now: another run of its workflow holds its
 * item. Only a top-level run on an item in one of `statuses` is checked, and only then is
 * `lockAdmission` taken, so the read and the caller's write are one admission decision.
 */
export async function heldItemRefusal(
  query: TransactionQuery,
  runId: string,
  statuses: readonly WorkflowRunStatus[]
): Promise<WorkflowItemHeldError | undefined> {
  const run = (
    await query<{ workflow_name: string; item_id: string; status: WorkflowRunStatus; key: string }>(
      `SELECT w.workflow_name, w.item_id, w.status, i.key
         FROM remote_agent_workflow_runs w JOIN remote_agent_items i ON i.id = w.item_id
        WHERE w.id = $1 AND w.parent_run_id IS NULL`,
      [runId]
    )
  ).rows[0];
  if (!run || !statuses.includes(run.status)) return undefined;
  await lockAdmission(query);
  const itemId = String(run.item_id);
  // Leave `runId` out before choosing the oldest holder: an admitted pending run holds the
  // item itself and would otherwise hide a newer holder (one an older binary admitted).
  const others = (await liveItemRuns(query, itemId)).filter(other => other.id !== runId);
  const holder = itemHolder(itemHolders(others), {
    runId,
    workflow: run.workflow_name,
    itemId,
  });
  return holder === undefined
    ? undefined
    : new WorkflowItemHeldError(runId, holder, run.workflow_name, run.key);
}

// One hold per install. The key leaves room for a scoped hold without a table change.
export const INSTALL_HOLD_ID = 'install';

interface InstallHoldRow {
  set_by: string;
  set_at: string | Date;
}

export async function readInstallHold(query: TransactionQuery): Promise<InstallHold | null> {
  const row = (
    await query<InstallHoldRow>(
      'SELECT set_by, set_at FROM remote_agent_install_hold WHERE id = $1',
      [INSTALL_HOLD_ID]
    )
  ).rows[0];
  return row ? { setBy: row.set_by, setAt: toHydratedTimestamp(row.set_at).toISOString() } : null;
}

/** Whether `runId` is a pending top-level run that nothing admitted: it has no start request. */
async function isUnadmittedPendingRoot(query: TransactionQuery, runId: string): Promise<boolean> {
  const unadmitted = await query(
    `SELECT 1 FROM remote_agent_workflow_runs w
      WHERE w.id = $1 AND w.status = 'pending' AND w.parent_run_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM remote_agent_resource_start_requests q WHERE q.id = w.id)`,
    [runId]
  );
  return unadmitted.rows.length > 0;
}

/**
 * The refusal for claiming pending run `runId` while the hold is set, when nothing admitted
 * the run: a top-level run with no start request. A run admitted before the hold, and a
 * child of a running parent, are not new work and are never held.
 */
export async function installHoldRefusal(
  query: TransactionQuery,
  runId: string
): Promise<InstallHeldError | undefined> {
  if (!(await isUnadmittedPendingRoot(query, runId))) return undefined;
  await lockAdmission(query);
  const hold = await readInstallHold(query);
  return hold ? new InstallHeldError(hold) : undefined;
}

/**
 * The refusal for claiming pending run `runId`, which no start request admitted, while the
 * run limit is full (`runLimitRefusal`). A run admitted through a resource start was
 * counted when it was admitted, so its claim is never refused here.
 */
export async function pendingRunLimitRefusal(
  query: TransactionQuery,
  runId: string
): Promise<RunLimitError | undefined> {
  const unadmitted = await query(
    `SELECT 1 FROM remote_agent_workflow_runs w
      WHERE w.id = $1 AND w.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM remote_agent_resource_start_requests q WHERE q.id = w.id)`,
    [runId]
  );
  return unadmitted.rows.length === 0 ? undefined : runLimitRefusal(query, runId);
}

/** The run trees that count against the run limit, as their roots' ids, oldest first. */
async function countedTrees(query: TransactionQuery): Promise<string[]> {
  const counted = await query<{ id: string }>(
    `WITH RECURSIVE up(id, parent_run_id) AS (
       SELECT w.id, w.parent_run_id FROM remote_agent_workflow_runs w
        WHERE w.status = 'running'
           OR (w.status = 'pending' AND w.parent_run_id IS NULL AND EXISTS (
             SELECT 1 FROM remote_agent_resource_start_requests q
              WHERE q.id = w.id AND q.status = 'admitted'))
       UNION
       SELECT p.id, p.parent_run_id FROM remote_agent_workflow_runs p
         JOIN up ON p.id = up.parent_run_id
     )
     SELECT r.id FROM remote_agent_workflow_runs r
      WHERE r.parent_run_id IS NULL AND r.id IN (SELECT id FROM up)
      ORDER BY r.started_at, r.id`
  );
  return counted.rows.map(row => String(row.id));
}

/** The root of the run tree `runId` belongs to. */
async function treeRoot(query: TransactionQuery, runId: string): Promise<string | undefined> {
  const root = await query<{ id: string }>(
    `WITH RECURSIVE up(id, parent_run_id) AS (
       SELECT id, parent_run_id FROM remote_agent_workflow_runs WHERE id = $1
       UNION
       SELECT p.id, p.parent_run_id FROM remote_agent_workflow_runs p
         JOIN up ON p.id = up.parent_run_id
     )
     SELECT id FROM up WHERE parent_run_id IS NULL`,
    [runId]
  );
  return root.rows[0] === undefined ? undefined : String(root.rows[0].id);
}

/**
 * The run limit (`concurrency.runs`) and how many run trees count against it, with the oldest
 * tree's root. A tree is a top-level run and its `workflow:` sub-runs. It counts while any
 * run in it is running, and while its root is admitted and no executor has claimed it yet, so
 * a drain cannot admit past the limit while its starts boot. A tree counts once, however many
 * of its runs execute: a sub-run runs inside its tree's room, and counting it again would
 * deadlock a root at the limit that waits on its child. A tree whose runs are all paused
 * executes nothing and does not count. Null when no limit is set. Read under `lockAdmission`
 * by every admission point, so the config is read fresh each time.
 */
export async function readRunLimit(
  query: TransactionQuery
): Promise<(RunLimit & { oldest: string | undefined }) | null> {
  const limit = await loadRunLimit();
  if (limit === undefined) return null;
  const trees = await countedTrees(query);
  return { limit, live: trees.length, oldest: trees[0] };
}

/**
 * What the run limit leaves room for now: how many more runs it admits (`Infinity` without
 * a limit), and while it is full, the oldest counted tree's root as the blocker a queued
 * start records. Admission checks it after every other rule, so a start it holds back waits
 * for nothing else.
 */
async function readRunRoom(
  query: TransactionQuery
): Promise<{ room: number; blocker: ResourceBlocker | null }> {
  const runLimit = await readRunLimit(query);
  if (!runLimit) return { room: Infinity, blocker: null };
  const { limit, live, oldest } = runLimit;
  const room = Math.max(0, limit - live);
  return { room, blocker: room === 0 && oldest !== undefined ? { kind: 'run', id: oldest } : null };
}

/**
 * This host's queued starts that a drain would admit now (`drainableStarts`) on resources
 * other than `resource`, oldest first, and the queue position of every queued start of the
 * host. Under the run limit the host's older starts take its room before newer ones, on
 * any resource, so the host's queue keeps its order across resources.
 */
async function runnableHostStarts(
  query: TransactionQuery,
  hostId: string,
  resource: string
): Promise<{ elsewhere: { id: string; position: number }[]; positions: Map<string, number> }> {
  const queued = await query<{ id: string; resource_key: string; queue_position: number | string }>(
    `SELECT id, resource_key, queue_position FROM remote_agent_resource_start_requests
      WHERE host_id = $1 AND status = 'queued' ORDER BY queue_position`,
    [hostId]
  );
  const positions = new Map(queued.rows.map(row => [String(row.id), Number(row.queue_position)]));
  const elsewhere: { id: string; position: number }[] = [];
  for (const other of new Set(queued.rows.map(row => row.resource_key))) {
    if (other === resource) continue;
    const { capacity } = await lockResourceSlotForAdmission(query, other);
    const slot = await resourceStartOccupancy(query, other, capacity);
    for (const start of drainableStarts(slot, hostId))
      elsewhere.push({ id: start.id, position: positions.get(start.id) ?? Infinity });
  }
  return { elsewhere: elsewhere.sort((a, b) => a.position - b.position), positions };
}

/**
 * What keeps a new start from admission on `slot` (`resourceStartBlocker`), with the run
 * limit applied last. With nothing on the resource in its way, the limit blocks it while full
 * (the oldest counted tree), or while the host's older runnable starts on other resources fill
 * the room (the oldest of them). `overlaps` is whether the resource itself refuses it, which
 * `overlap: skip` acts on: a start the limit holds back queues, and so does one held only by
 * an older request of its host, which the limit keeps queued, when its item, checkout and
 * the slot's capacity would all admit it.
 */
export async function underRunLimit(
  query: TransactionQuery,
  start: {
    hostId: string;
    resource: string;
    launch: PreparedWorkflowLaunch;
    itemId: string | null;
  },
  slot: ResourceSlotOccupancy
): Promise<{ blocker: ResourceBlocker | null; overlaps: boolean }> {
  const refuses = (occupancy: ResourceSlotOccupancy) =>
    resourceStartBlocker(occupancy, start.launch, start.hostId, start.itemId);
  const slotBlocker = refuses(slot);
  if ((await loadRunLimit()) === undefined)
    return { blocker: slotBlocker, overlaps: slotBlocker !== null };
  if (slotBlocker) {
    const own =
      slotBlocker.kind === 'request'
        ? refuses({ ...slot, queue: [], queueError: undefined })
        : slotBlocker;
    return { blocker: slotBlocker, overlaps: own !== null };
  }
  const { room, blocker } = await readRunRoom(query);
  if (blocker || room === Infinity) return { blocker, overlaps: false };
  const { elsewhere } = await runnableHostStarts(query, start.hostId, start.resource);
  const first = elsewhere[0];
  return {
    blocker: first && elsewhere.length >= room ? { kind: 'request', id: first.id } : null,
    overlaps: false,
  };
}

/**
 * The prefix of `starts`, drainable on `resource` for `hostId`, that the run limit admits
 * now: the room goes to the host's oldest runnable starts across all its resources, and only
 * those on this resource are returned. A drain of each resource in turn then admits in the
 * host's queue order.
 */
export async function withinRunRoom<T extends { id: string }>(
  query: TransactionQuery,
  hostId: string,
  resource: string,
  starts: T[]
): Promise<T[]> {
  const { room } = await readRunRoom(query);
  if (room === Infinity) return starts;
  const { elsewhere, positions } = await runnableHostStarts(query, hostId, resource);
  const admitted = new Set(
    [
      ...starts.map(start => ({ id: start.id, position: positions.get(start.id) ?? Infinity })),
      ...elsewhere,
    ]
      .sort((a, b) => a.position - b.position)
      .slice(0, room)
      .map(start => start.id)
  );
  return starts.filter(start => admitted.has(start.id));
}

/**
 * `RunLimitError` while the run limit is full and run `runId` is about to execute in a tree
 * that does not count yet: a new or resumed root, or a sub-run whose tree has nothing running.
 * A run whose tree already counts runs inside that tree's room. Takes `lockAdmission` only
 * when a limit is set, so an install without one decides claims and resumes as it did before.
 */
export async function runLimitRefusal(
  query: TransactionQuery,
  runId: string
): Promise<RunLimitError | undefined> {
  const limit = await loadRunLimit();
  if (limit === undefined) return undefined;
  await lockAdmission(query);
  const trees = await countedTrees(query);
  const root = await treeRoot(query, runId);
  if (root !== undefined && trees.includes(root)) return undefined;
  return trees.length >= limit ? new RunLimitError({ limit, live: trees.length }) : undefined;
}

/**
 * Create the slot if needed and take its lock for the rest of the transaction, then
 * return its recorded capacity. A `declaredCapacity` replaces the recorded one. Reads no
 * config, so releasing a slot never depends on the install config being readable.
 */
export async function lockResourceSlot(
  query: TransactionQuery,
  resource: string,
  declaredCapacity?: number
): Promise<{ capacity: number }> {
  const recorded = recordedResourceCapacity(undefined, declaredCapacity);
  await query(
    `INSERT INTO remote_agent_resource_slots (resource_key, capacity) VALUES ($1, $2)
       ON CONFLICT(resource_key) DO ${
         declaredCapacity === undefined ? 'NOTHING' : 'UPDATE SET capacity = excluded.capacity'
       }`,
    [resource, recorded]
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
  return { capacity: Number(slot.rows[0]?.capacity ?? recorded) };
}

/**
 * `lockResourceSlot`, returning the capacity admission uses now: the install config's
 * number for the resource wins over the recorded one.
 */
export async function lockResourceSlotForAdmission(
  query: TransactionQuery,
  resource: string,
  declaredCapacity?: number
): Promise<{ capacity: number }> {
  const { capacity } = await lockResourceSlot(query, resource, declaredCapacity);
  return { capacity: (await loadResourceCapacities()).get(resource) ?? capacity };
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
 * What a run-start slot holds, read under its lock (`lockResourceSlot`) and `lockAdmission`:
 * live holders, capacity waiters, the checkouts live admitted runs hold, the items live runs
 * hold, and the queued start requests. The queued rows are locked too, so a concurrent
 * withdrawal cannot race their admission.
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
    `SELECT id, host_id, resource_key, status, launch, item_id FROM remote_agent_resource_start_requests
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
    heldItems: itemHolders(await liveItemRuns(query)),
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
    item_id: z.preprocess(value => (value == null ? null : String(value)), z.string().nullable()),
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
  return { id: row.id, hostId: row.host_id, launch: row.launch, itemId: row.item_id };
}
