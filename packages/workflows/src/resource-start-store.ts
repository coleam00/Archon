import { createLogger } from '@archon/paths';
import { AdmissionCheckoutGuardError, readAdmissionCheckoutGuard } from './schemas/resource-start';
import type { z } from 'zod';
import type {
  PreparedWorkflowLaunch,
  ResourceStartBindingIntent,
  ResourceStartDisposition,
  ResourceStartIntent,
  SourceReceiptInput,
  SourceReceiptAcceptance,
  startBindingPreparationStatusSchema,
  resourceStartRequestStatusSchema,
} from './schemas/resource-start';
import {
  answeredPauseContinuation,
  pendingWorkflowWaitDeadline,
  workflowWaitDue,
  readCapacityWait,
  type WorkflowRun,
  type WorkflowRunStatus,
} from './schemas/workflow-run';
import type { ResumeRefusal, WorkflowResumeCursor } from './store';

export class SourceReceiptDigestConflictError extends Error {}

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

export interface StartBindingInspection {
  receiptId: string;
  bindingId: string;
  bindingRevision: string | null;
  hostId: string | null;
  status: z.infer<typeof startBindingPreparationStatusSchema>;
  ownerId: string | null;
  error: string | null;
  intent: ResourceStartBindingIntent | null;
  requestStatus: ResourceStartRequestInspection['status'] | null;
  disposition: ResourceStartDisposition | null;
}

export interface StartReceiptInspection {
  id: string;
  sourceInstanceId: string;
  deliveryId: string | null;
  contentDigest: string;
  receivedAt: string;
  occurredAt: string | null;
  sourceActor: SourceReceiptInput['sourceActor'];
  outcome: SourceReceiptAcceptance['outcome'];
  reason: string | null;
  bindings: StartBindingInspection[];
}

export interface ResourceStartRequestInspection {
  id: string;
  resource: string;
  hostId: string;
  overlap: ResourceStartIntent['overlap'];
  status: z.infer<typeof resourceStartRequestStatusSchema>;
  runStatus: WorkflowRunStatus | null;
  blocker: Extract<ResourceStartDisposition, { status: 'queued' }>['blocker'] | null;
  blockerRunStatus: WorkflowRunStatus | null;
  launch: PreparedWorkflowLaunch;
}

export function validateStartReceiptLimit(limit = 50): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Receipt limit must be an integer from 1 to 1000.');
  return limit;
}

// The receipt schema accepts UTC datetimes with optional seconds and arbitrary
// fractional precision; Date.parse would discard precision below milliseconds.
function receiptTimeKey(receivedAt: string): string {
  const dot = receivedAt.indexOf('.');
  const seconds = receivedAt.slice(0, dot === -1 ? -1 : dot).padEnd(19, ':00');
  const fraction = dot === -1 ? '' : receivedAt.slice(dot + 1, -1).replace(/0+$/, '');
  return `${seconds}.${fraction}`;
}

export function compareStartReceipts(
  a: Pick<SourceReceiptInput, 'id' | 'receivedAt'>,
  b: Pick<SourceReceiptInput, 'id' | 'receivedAt'>
): number {
  return (
    compareCodeUnits(receiptTimeKey(b.receivedAt), receiptTimeKey(a.receivedAt)) ||
    compareCodeUnits(b.id, a.id)
  );
}

/**
 * Ascending code-unit order, as SQLite's default BINARY collation sorts text. In-process
 * stores use it instead of localeCompare, whose result depends on the runtime's locale.
 * Postgres sorts by the database collation, so mixed-case values may order differently there.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type ResourceBlocker = Extract<ResourceStartDisposition, { status: 'queued' }>['blocker'];

/**
 * A paused admitted run that gave back its slot and whose continuation was then refused
 * for capacity (`readCapacityWait`). It has not lost its admission, so it counts against
 * capacity like a holder and goes ahead of queued new starts; waiters keep the order of
 * their first refusal.
 */
export interface CapacityWaiter {
  id: string;
  since: string;
}

/**
 * The waiters among `candidates`, in the order they keep. A store passes its paused runs
 * that have an admitted request on the resource and no run holder there.
 */
export function capacityWaiters(
  candidates: Iterable<Pick<WorkflowRun, 'id' | 'status' | 'metadata'>>
): CapacityWaiter[] {
  const waiters: CapacityWaiter[] = [];
  for (const run of candidates) {
    const wait = run.status === 'paused' ? readCapacityWait(run.metadata) : undefined;
    if (wait) waiters.push({ id: run.id, since: wait.since });
  }
  return waiters.sort(compareCapacityWaiters);
}

function compareCapacityWaiters(a: CapacityWaiter, b: CapacityWaiter): number {
  return compareCodeUnits(a.since, b.since) || compareCodeUnits(a.id, b.id);
}

const checkoutPath = (path: string): string => JSON.stringify(['path', path]);
const checkoutBranch = (codebaseId: string, branch: string): string =>
  JSON.stringify(['branch', codebaseId, branch]);

/**
 * The checkout a launch locks, when admission can know it before execution starts: the
 * in-place path, or the reusable worktree an explicit branch names in its codebase. A
 * worktree lane without a branch gets a checkout of its own, so it never shares one.
 */
function launchCheckout(launch: PreparedWorkflowLaunch): string | undefined {
  const { cwd, isolation } = launch.execution;
  if (isolation.kind === 'in-place') return checkoutPath(cwd);
  return isolation.branch === undefined
    ? undefined
    : checkoutBranch(launch.run.codebase_id, isolation.branch);
}

export interface ReusableCheckout {
  codebaseId: string;
  branch: string;
  workingPath: string;
}

function checkoutKeys(
  launch: PreparedWorkflowLaunch | undefined,
  workingPath: string | null | undefined,
  reusable: readonly ReusableCheckout[]
): Set<string> {
  const keys = new Set(
    [
      launch ? launchCheckout(launch) : undefined,
      workingPath ? checkoutPath(workingPath) : undefined,
    ].filter((key): key is string => key !== undefined)
  );
  for (const checkout of reusable)
    if (keys.has(checkoutBranch(checkout.codebaseId, checkout.branch)))
      keys.add(checkoutPath(checkout.workingPath));
  for (const checkout of reusable)
    if (keys.has(checkoutPath(checkout.workingPath)))
      keys.add(checkoutBranch(checkout.codebaseId, checkout.branch));
  return keys;
}

/** Oldest-first holders contribute launch identities, paths and registered branch aliases. */
export function heldCheckouts(
  live: Iterable<{ id: string; working_path?: string | null; launch?: PreparedWorkflowLaunch }>,
  reusable: readonly ReusableCheckout[] = []
): Map<string, string> {
  const held = new Map<string, string>();
  for (const run of live) {
    for (const key of checkoutKeys(run.launch, run.working_path, reusable))
      if (!held.has(key)) held.set(key, run.id);
  }
  return held;
}

/** A queued start request with what admission needs to decide it. */
export interface QueuedStart {
  id: string;
  hostId: string;
  launch: PreparedWorkflowLaunch;
}

/**
 * What one resource slot holds, read inside the store's slot lock. Every store decides
 * admission, drain and resume from this through the functions below, so the rules agree.
 */
export interface ResourceSlotOccupancy {
  capacity: number;
  /** Live holders, oldest first. */
  holders: readonly { id: string }[];
  waiters: readonly CapacityWaiter[];
  /** Queued start requests, oldest first. */
  queue: readonly QueuedStart[];
  /** Checkouts requiring local serialization, including holders not provably foreign. */
  heldCheckouts: ReadonlyMap<string, string>;
  foreignHeldCheckouts: ReadonlyMap<string, string>;
  /** Oldest foreign holder whose missing or corrupt launch and absent path hide its checkout. */
  unknownForeignCheckoutHolder?: string;
  reusableCheckouts: readonly ReusableCheckout[];
}

function checkoutHolder(
  slot: Pick<
    ResourceSlotOccupancy,
    'heldCheckouts' | 'foreignHeldCheckouts' | 'unknownForeignCheckoutHolder'
  >,
  launch: PreparedWorkflowLaunch
): string | undefined {
  const checkout = launchCheckout(launch);
  if (checkout === undefined) return undefined;
  return (
    slot.heldCheckouts.get(checkout) ??
    (readAdmissionCheckoutGuard(launch)
      ? (slot.foreignHeldCheckouts.get(checkout) ?? slot.unknownForeignCheckoutHolder)
      : undefined)
  );
}

function validQueuedStarts(slot: ResourceSlotOccupancy): QueuedStart[] {
  return slot.queue.filter(start => {
    try {
      readAdmissionCheckoutGuard(start.launch);
      return true;
    } catch (error) {
      if (!(error instanceof AdmissionCheckoutGuardError)) throw error;
      // Keep the corrupt request inspectable and withdrawable, without letting it
      // stall valid work. Never infer a guard value from malformed persisted data.
      createLogger('resource-start').error(
        { err: error, requestId: start.id },
        'resource_start.invalid_queued_guard'
      );
      return false;
    }
  });
}

/**
 * The queued requests that could run now, oldest first. A request whose checkout a live
 * run holds keeps its place and is passed over until the checkout frees, so FIFO holds
 * per checkout and the slot goes to the next request that can run.
 */
function runnableQueue(slot: ResourceSlotOccupancy): QueuedStart[] {
  return validQueuedStarts(slot).filter(start => checkoutHolder(slot, start.launch) === undefined);
}

/** What keeps a new start request for `launch` from being admitted now. */
export function resourceStartBlocker(
  slot: ResourceSlotOccupancy,
  launch: PreparedWorkflowLaunch
): ResourceBlocker | null {
  readAdmissionCheckoutGuard(launch);
  // An older request that could run keeps FIFO even when a slot is free.
  const older = runnableQueue(slot)[0];
  if (older) return { kind: 'request', id: older.id };
  const holder = checkoutHolder(slot, launch);
  if (holder !== undefined) return { kind: 'run', id: holder };
  const first = slot.holders[0] ?? slot.waiters[0];
  return first && slot.holders.length + slot.waiters.length >= slot.capacity
    ? { kind: 'run', id: first.id }
    : null;
}

/**
 * The queued requests a drain by `hostId` admits now, in order. It stops at the first
 * request that could run but belongs to another host: FIFO order is per resource, not
 * per host. A request admitted here holds its checkout for the rest of the drain.
 */
export function drainableStarts(slot: ResourceSlotOccupancy, hostId: string): QueuedStart[] {
  const free = slot.capacity - slot.holders.length - slot.waiters.length;
  const held = new Map(slot.heldCheckouts);
  const admitted: QueuedStart[] = [];
  for (const start of validQueuedStarts(slot)) {
    if (admitted.length >= free) break;
    if (checkoutHolder({ ...slot, heldCheckouts: held }, start.launch) !== undefined) continue;
    if (start.hostId !== hostId) break;
    admitted.push(start);
    for (const checkout of checkoutKeys(start.launch, undefined, slot.reusableCheckouts))
      held.set(checkout, start.id);
  }
  return admitted;
}

/**
 * What keeps an admitted failed or paused run from resuming now.
 *
 * A paused run that still holds its slot keeps it. A paused run that gave its slot back
 * never lost its admission, so it waits only for holders and for waiters refused before
 * it, never for queued new starts. A failed run's claim ended, so its resume is a new
 * decision and must not pass any promised work: a waiter the slot cannot also fit, or a
 * queued request that could run.
 */
export function resourceResumeBlocker(
  slot: ResourceSlotOccupancy,
  run: Pick<WorkflowRun, 'id' | 'metadata'> & { status: 'failed' | 'paused' }
): ResourceBlocker | null {
  const others = slot.holders.filter(holder => holder.id !== run.id);
  if (others[0] && others.length >= slot.capacity) return { kind: 'run', id: others[0].id };
  if (others.length < slot.holders.length) return null;
  if (run.status === 'paused') {
    const own = readCapacityWait(run.metadata);
    const ahead = slot.waiters.filter(
      waiter =>
        waiter.id !== run.id &&
        (own === undefined || compareCapacityWaiters(waiter, { id: run.id, ...own }) < 0)
    );
    return ahead[0] && others.length + ahead.length >= slot.capacity
      ? { kind: 'run', id: ahead[0].id }
      : null;
  }
  const waiter = slot.waiters[0];
  if (waiter && others.length + slot.waiters.length >= slot.capacity)
    return { kind: 'run', id: waiter.id };
  const queued = runnableQueue(slot)[0];
  return queued ? { kind: 'request', id: queued.id } : null;
}

/**
 * What a refused resume leaves behind. A paused run that is ready to continue (its pause
 * answered, its wait due or signaled, or a continuation host's claim) becomes a capacity
 * waiter, from whichever surface resumed it: answering a gate resumes without a cursor. An
 * early resume of a pause that is not ready must not hold capacity for it.
 */
export function resumeRefusal(
  run: Pick<WorkflowRun, 'status' | 'metadata'>,
  cursor: WorkflowResumeCursor | undefined
): ResumeRefusal {
  if (run.status !== 'paused') return 'failed';
  const wait = pendingWorkflowWaitDeadline(run);
  const ready =
    cursor !== undefined ||
    readCapacityWait(run.metadata) !== undefined ||
    answeredPauseContinuation(run) !== undefined ||
    (wait !== undefined && workflowWaitDue(wait, Date.now()));
  return ready ? 'waiting' : 'paused';
}

export type QueuedResourceStartInspection =
  | ResourceStartRequestInspection
  | { id: string; resource?: string; receiptId?: string; error: unknown };

export interface IResourceStartStore {
  admitResourceStart(intent: ResourceStartIntent): Promise<ResourceStartDisposition>;
  drainResourceStarts(options: {
    resource: string;
    hostId: string;
  }): Promise<ResourceStartDisposition[]>;
  /**
   * Whether this source already holds a receipt for the delivery. Only a gate for checks that
   * belong to a first acceptance; `acceptStartReceipt` still decides replay versus conflict.
   */
  hasStartReceiptForDelivery(sourceInstanceId: string, deliveryId: string): Promise<boolean>;
  acceptStartReceipt(
    input: SourceReceiptAcceptance
  ): Promise<{ receiptId: string; replay: boolean }>;
  getStartReceipt(id: string): Promise<StartReceiptInspection | null>;
  listStartReceipts(
    limit?: number
  ): Promise<
    Pick<
      StartReceiptInspection,
      'id' | 'sourceInstanceId' | 'deliveryId' | 'outcome' | 'reason' | 'receivedAt'
    >[]
  >;
  listPendingStartBindings(options: {
    hostId: string;
    limit?: number;
  }): Promise<StartBindingInspection[]>;
  getResourceStartRequest(id: string): Promise<ResourceStartRequestInspection | null>;
  listQueuedResourceStartsForHost(hostId: string): Promise<QueuedResourceStartInspection[]>;
  withdrawQueuedResourceStart(id: string): Promise<PreparedWorkflowLaunch | null>;
  claimStartBindingPreparation(input: {
    receiptId: string;
    bindingId: string;
    ownerId: string;
  }): Promise<boolean>;
  completeStartBindingPreparation(input: {
    receiptId: string;
    bindingId: string;
    ownerId: string;
    launch: PreparedWorkflowLaunch;
  }): Promise<ResourceStartDisposition | null>;
  failStartBindingPreparation(input: {
    receiptId: string;
    bindingId: string;
    ownerId: string;
    retryable: boolean;
    error: string;
  }): Promise<boolean>;
  resetStartBindingPreparation(input: {
    receiptId: string;
    bindingId: string;
    ownerId: string;
  }): Promise<boolean>;
}
