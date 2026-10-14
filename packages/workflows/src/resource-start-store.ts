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

/**
 * What one resource slot holds, read inside the store's slot lock. Every store decides
 * admission, drain and resume from this through the functions below, so the rules agree.
 */
export interface ResourceSlotOccupancy {
  capacity: number;
  /** Live holders, oldest first. */
  holders: readonly { id: string }[];
  waiters: readonly CapacityWaiter[];
  /** The oldest queued start request. */
  queued: string | undefined;
}

/** What keeps a new start request from being admitted now. */
export function resourceStartBlocker(slot: ResourceSlotOccupancy): ResourceBlocker | null {
  // An older queued request keeps FIFO even when a slot is free.
  if (slot.queued !== undefined) return { kind: 'request', id: slot.queued };
  const first = slot.holders[0] ?? slot.waiters[0];
  return first && slot.holders.length + slot.waiters.length >= slot.capacity
    ? { kind: 'run', id: first.id }
    : null;
}

/** How many queued requests a drain may admit now. */
export function freeResourceSlots(slot: Omit<ResourceSlotOccupancy, 'queued'>): number {
  return slot.capacity - slot.holders.length - slot.waiters.length;
}

/**
 * What keeps an admitted failed or paused run from resuming now.
 *
 * A paused run that still holds its slot keeps it. A paused run that gave its slot back
 * never lost its admission, so it waits only for holders and for waiters refused before
 * it, never for queued new starts. A failed run's claim ended, so its resume is a new
 * decision and must not pass any promised work: a waiter or a queued request.
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
  if (slot.waiters[0]) return { kind: 'run', id: slot.waiters[0].id };
  return slot.queued === undefined ? null : { kind: 'request', id: slot.queued };
}

/**
 * What a refused resume leaves behind. A paused run that is ready to continue (its pause
 * answered, its wait due, or a continuation host's claim) becomes a capacity waiter, from
 * whichever surface resumed it: answering a gate resumes without a cursor. An early resume
 * of a pause that is not ready must not hold capacity for it.
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
    (wait !== undefined && Date.parse(wait.resumeAt) <= Date.now());
  return ready ? 'waiting' : 'paused';
}

export interface IResourceStartStore {
  admitResourceStart(intent: ResourceStartIntent): Promise<ResourceStartDisposition>;
  drainResourceStarts(options: {
    resource: string;
    hostId: string;
  }): Promise<ResourceStartDisposition[]>;
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
  listQueuedResourceStartsForHost(hostId: string): Promise<ResourceStartRequestInspection[]>;
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
