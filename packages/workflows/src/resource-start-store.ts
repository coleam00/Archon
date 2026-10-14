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
import type { WorkflowRunStatus } from './schemas/workflow-run';

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
