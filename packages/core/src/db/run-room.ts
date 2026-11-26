/**
 * The run limit's (`concurrency.runs`) part in admitting queued starts. A host's queued starts
 * are decided by one walk (`decideHostStarts`); the drain admits from it, a new start of the
 * host is ordered behind it, and the report of starts waiting for the limit reads it. So a
 * start is reported waiting for the limit only when the next drain holds it for that.
 * Without a limit, nothing here reads another resource or takes `lockAdmission`.
 */
import { decideHostStarts, drainableStarts } from '@archon/workflows/host-start-decision';
import type { HostStartVerdict } from '@archon/workflows/host-start-decision';
import {
  hasPriority,
  type QueuedStart,
  type ResourceBlocker,
  type ResourceSlotOccupancy,
} from '@archon/workflows/resource-start-store';
import type { RunLimit } from '@archon/workflows/schemas/run-limit';
import {
  lockResourceSlotForAdmission,
  readRunLimit,
  resourceStartOccupancy,
  type TransactionQuery,
} from './resource-slots';
import { PRIORITY_ITEMS_CTE, queueOrderSql } from './item-priorities';

/**
 * What the run limit leaves room for now: how many more trees it admits (`Infinity` without
 * a limit), and while it is full, the oldest counted tree's root as the blocker a queued
 * start records.
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
 * The decision for every queued start of `hostId`, in its queue order (`queueOrderSql`), with
 * `room` for the run limit. Locks each resource the host queues on and reads it; `known` is a
 * resource the caller already locked and read.
 */
async function readHostDecision(
  query: TransactionQuery,
  hostId: string,
  room: number,
  known?: { resource: string; slot: ResourceSlotOccupancy }
): Promise<HostStartVerdict[]> {
  const queued = await query<{ id: string; resource_key: string }>(
    `WITH RECURSIVE ${PRIORITY_ITEMS_CTE}
     SELECT r.id, r.resource_key FROM remote_agent_resource_start_requests r
      WHERE r.host_id = $1 AND r.status = 'queued' ORDER BY ${queueOrderSql('r')}`,
    [hostId]
  );
  const slots = new Map<string, ResourceSlotOccupancy>();
  if (known) slots.set(known.resource, known.slot);
  for (const { resource_key: resource } of queued.rows) {
    if (slots.has(resource)) continue;
    const { capacity } = await lockResourceSlotForAdmission(query, resource);
    slots.set(resource, await resourceStartOccupancy(query, resource, capacity));
  }
  return decideHostStarts({ hostId, slots, order: queued.rows.map(row => String(row.id)), room });
}

/**
 * The queued starts a drain of `hostId` on `resource` admits now, in order, from `slot` read
 * under the resource's lock. Without a limit, all its drainable starts (`drainableStarts`).
 * With one, the host's decision admits only up to the host's next start admitted on another
 * resource: a host drain that passes over its resources until a pass admits nothing
 * (`drainResourceStartHost`) therefore admits in the host's queue order, and each resource's
 * drain stays its own transaction, which reads room taken between two of them.
 */
export async function drainAdmits(
  query: TransactionQuery,
  hostId: string,
  resource: string,
  slot: ResourceSlotOccupancy
): Promise<QueuedStart[]> {
  const { room } = await readRunRoom(query);
  if (room === Infinity) return drainableStarts(slot, hostId);
  const admits: QueuedStart[] = [];
  for (const verdict of await readHostDecision(query, hostId, room, { resource, slot })) {
    if (verdict.verdict !== 'admit') continue;
    if (verdict.resource !== resource) break;
    admits.push(verdict.start);
  }
  return admits;
}

/**
 * What the run limit puts in the way of a new start of `hostId` on `resource` that its resource
 * would admit (`resourceStartBlocker` returned null): the oldest counted tree while the limit
 * is full, or else the host's first queued start its decision admits on another resource,
 * which goes first as an older request of the host does on the same resource. A new start on
 * an item with priority (`hasPriority`, read from `slot`) goes ahead of ordinary ones, so
 * only a priority start admitted there holds it. Null otherwise. The caller applies `overlap`
 * to it as to any blocker.
 */
export async function runLimitBlocker(
  query: TransactionQuery,
  hostId: string,
  resource: string,
  slot: ResourceSlotOccupancy,
  itemId: string | null
): Promise<ResourceBlocker | null> {
  const { room, blocker } = await readRunRoom(query);
  if (blocker || room === Infinity) return blocker;
  const priority = hasPriority(slot, itemId);
  const first = (await readHostDecision(query, hostId, room)).find(
    verdict =>
      verdict.verdict === 'admit' &&
      verdict.resource !== resource &&
      (!priority || hasPriority(slot, verdict.start.itemId))
  );
  return first ? { kind: 'request', id: first.start.id } : null;
}

/**
 * The run limit with the queued requests that only it holds now: those each host's decision
 * holds for the limit's room (`decideHostStarts`), each host read as its next drain reads it.
 * Null when no limit is set.
 */
export async function readRunLimitWaiting(
  query: TransactionQuery
): Promise<(RunLimit & { waiting: string[] }) | null> {
  const runLimit = await readRunLimit(query);
  if (!runLimit) return null;
  const room = Math.max(0, runLimit.limit - runLimit.live);
  const hosts = await query<{ host_id: string }>(
    `SELECT DISTINCT host_id FROM remote_agent_resource_start_requests
      WHERE status = 'queued' ORDER BY host_id`
  );
  const waiting: string[] = [];
  for (const { host_id: hostId } of hosts.rows)
    for (const verdict of await readHostDecision(query, hostId, room))
      if (verdict.verdict === 'held' && verdict.by === 'run-limit') waiting.push(verdict.start.id);
  return { limit: runLimit.limit, live: runLimit.live, waiting };
}
