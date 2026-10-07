import type {
  PreparedWorkflowLaunch,
  ResourceStartBindingIntent,
  ResourceStartDisposition,
  ResourceStartIntent,
  SourceReceiptInput,
  SourceReceiptAcceptance,
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
  status: 'pending' | 'preparing' | 'failed' | 'rejected' | 'unmatched' | 'complete';
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
  status: ResourceStartDisposition['status'] | 'withdrawn';
  runStatus: WorkflowRunStatus | null;
  blocker: Extract<ResourceStartDisposition, { status: 'queued' }>['blocker'] | null;
  blockerRunStatus: WorkflowRunStatus | null;
  launch: PreparedWorkflowLaunch;
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
