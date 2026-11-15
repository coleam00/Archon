import { holdsWorkflowPath } from '@archon/workflows/workflow-path-lock';
import {
  validateStartReceiptLimit,
  skippedFireNotice,
  compareStartReceipts,
  capacityWaiters,
  drainableStarts,
  heldCheckouts,
  compareCodeUnits,
  type ReusableCheckout,
  resourceResumeBlocker,
  resourceStartBlocker,
  DIRECT_START_HOST_ID,
  recordedResourceCapacity,
  preparedBindingStart,
  SourceReceiptDigestConflictError,
  type IResourceStartStore,
  type ResourceBlocker,
  type ResourceSlotOccupancy,
  type ResourceStartRequestInspection,
  type StartReceiptInspection,
  type StartBindingInspection,
} from '@archon/workflows/resource-start-store';
import { WorkflowNotResumableError, type IWorkflowStore } from '@archon/workflows/store';
import { isTerminalRunStatus, type WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  preparedWorkflowLaunchSchema,
  type PreparedWorkflowLaunch,
  type ResourceStartDisposition,
  type ResourceStartIntent,
} from '@archon/workflows/schemas/resource-start';

export function createInMemoryResourceStartStore(
  createRun: IWorkflowStore['createWorkflowRun'],
  getRun: IWorkflowStore['getWorkflowRun'],
  listRuns: () => WorkflowRun[],
  listReusableCheckouts: () => Promise<readonly ReusableCheckout[]>,
  recordNotice: (notice: NonNullable<ReturnType<typeof skippedFireNotice>>) => Promise<void>
): IResourceStartStore & {
  /** Take a slot for an admitted failed or paused run's resume, or say what blocks it. */
  resume(run: WorkflowRun): Promise<ResourceBlocker | null>;
  /** Give back the slot of an admitted run; whether it held one. */
  release(id: string): Promise<boolean>;
  /** Stand in for the install config's `concurrency.resources.<resource>`. */
  setResourceCapacity(resource: string, capacity: number): Promise<void>;
} {
  const requests = new Map<string, ResourceStartRequestInspection>();
  const receipts = new Map<string, StartReceiptInspection>();
  const capacities = new Map<string, number>();
  const installed = new Map<string, number>();
  // Holders are implicit: an admitted request whose run is live, unless it gave its slot back.
  const released = new Set<string>();
  const receiptForDelivery = (
    sourceInstanceId: string,
    deliveryId: string
  ): StartReceiptInspection | undefined =>
    [...receipts.values()].find(
      receipt => receipt.sourceInstanceId === sourceInstanceId && receipt.deliveryId === deliveryId
    );
  const decision = (request: ResourceStartRequestInspection): ResourceStartDisposition => {
    if (request.status === 'admitted')
      return { status: 'admitted', requestId: request.id, runId: request.id };
    if ((request.status === 'queued' || request.status === 'skipped') && request.blocker)
      return { status: request.status, requestId: request.id, blocker: request.blocker };
    throw new Error('No executable disposition');
  };
  const inspect = async (
    request: ResourceStartRequestInspection
  ): Promise<ResourceStartRequestInspection> => ({
    ...structuredClone(request),
    runStatus: (await getRun(request.id))?.status ?? null,
    blockerRunStatus:
      request.blocker?.kind === 'run' ? ((await getRun(request.blocker.id))?.status ?? null) : null,
  });
  const occupancy = async (resource: string): Promise<ResourceSlotOccupancy> => {
    const holders: { id: string }[] = [];
    const candidates: WorkflowRun[] = [];
    const live: (WorkflowRun & { launch: PreparedWorkflowLaunch })[] = [];
    for (const request of requests.values()) {
      if (request.resource !== resource || request.status !== 'admitted') continue;
      const run = await getRun(request.id);
      if (!run || isTerminalRunStatus(run.status)) continue;
      live.push({ ...run, launch: request.launch });
      if (released.has(run.id)) candidates.push(run);
      else holders.push({ id: run.id });
    }
    const reusable = await listReusableCheckouts();
    return {
      capacity:
        installed.get(resource) ?? recordedResourceCapacity(capacities.get(resource), undefined),
      reusableCheckouts: reusable,
      holders,
      waiters: capacityWaiters(candidates),
      queue: [...requests.values()].filter(
        request => request.resource === resource && request.status === 'queued'
      ),
      heldCheckouts: heldCheckouts(live, reusable),
      foreignHeldCheckouts: heldCheckouts(
        listRuns()
          .filter(run => holdsWorkflowPath(run) && !live.some(local => local.id === run.id))
          .sort(
            (a, b) =>
              a.started_at.getTime() - b.started_at.getTime() || compareCodeUnits(a.id, b.id)
          )
          .map(run => ({
            ...run,
            launch:
              requests.get(run.id)?.status === 'admitted'
                ? requests.get(run.id)?.launch
                : undefined,
          })),
        reusable
      ),
    };
  };
  const admit = async (intent: ResourceStartIntent): Promise<ResourceStartDisposition> => {
    capacities.set(
      intent.resource,
      recordedResourceCapacity(capacities.get(intent.resource), intent.capacity)
    );
    const previous = requests.get(intent.launch.run.id);
    if (previous) return decision(previous);
    const launch = preparedWorkflowLaunchSchema.parse(intent.launch);
    const blocker = resourceStartBlocker(await occupancy(intent.resource), launch);
    const request: ResourceStartRequestInspection = {
      id: launch.run.id,
      resource: intent.resource,
      hostId: intent.hostId,
      overlap: intent.overlap,
      status: blocker ? (intent.overlap === 'skip' ? 'skipped' : 'queued') : 'admitted',
      blocker,
      runStatus: null,
      blockerRunStatus: null,
      launch,
    };
    if (!blocker) await createRun(launch.run);
    if (intent.receipt && request.status === 'skipped') {
      const receipt = receipts.get(intent.receipt.receiptId);
      if (!receipt) throw new Error('Resource start receipt missing');
      const notice = skippedFireNotice(
        receipt,
        { ...intent, bindingId: intent.receipt.bindingId },
        decision(request)
      );
      if (notice) await recordNotice(notice);
    }
    requests.set(request.id, request);
    return decision(request);
  };
  const binding = (input: {
    receiptId: string;
    bindingId: string;
  }): StartBindingInspection | undefined =>
    receipts.get(input.receiptId)?.bindings.find(item => item.bindingId === input.bindingId);
  const owned = (input: {
    receiptId: string;
    bindingId: string;
    ownerId: string;
  }): StartBindingInspection | undefined => {
    const item = binding(input);
    return item?.status === 'preparing' && item.ownerId === input.ownerId ? item : undefined;
  };
  const inspectReceipt = async (
    receipt: StartReceiptInspection
  ): Promise<StartReceiptInspection> => {
    const copy = structuredClone(receipt);
    for (const item of copy.bindings) {
      const request = item.disposition ? requests.get(item.disposition.requestId) : undefined;
      if (request) {
        item.requestStatus = request.status;
        item.disposition = request.status === 'withdrawn' ? null : decision(request);
      }
    }
    return copy;
  };
  return {
    resume: async run => {
      const request = requests.get(run.id);
      if (request?.status !== 'admitted') return null;
      if (run.status !== 'failed' && run.status !== 'paused')
        throw new WorkflowNotResumableError(run.id, run.status);
      const blocker = resourceResumeBlocker(await occupancy(request.resource), {
        ...run,
        status: run.status,
      });
      if (!blocker) released.delete(run.id);
      return blocker;
    },
    release: async id => {
      if (requests.get(id)?.status !== 'admitted' || released.has(id)) return false;
      released.add(id);
      return true;
    },
    setResourceCapacity: async (resource, capacity) => {
      installed.set(resource, capacity);
    },
    admitResourceStart: admit,
    admitPendingRun: async ({ resource, capacity, launch }) => {
      const id = launch.run.id;
      const previous = requests.get(id);
      if (previous?.status === 'admitted') return null;
      if (previous)
        throw new Error(`Run '${id}' already has a ${previous.status} resource request`);
      const run = await getRun(id);
      if (run?.status !== 'pending')
        throw new Error(`Run '${id}' is ${run?.status ?? 'missing'}, not pending`);
      const blocker = resourceStartBlocker(
        { ...(await occupancy(resource)), capacity: installed.get(resource) ?? capacity },
        launch
      );
      if (blocker) return blocker;
      requests.set(id, {
        id,
        resource,
        hostId: DIRECT_START_HOST_ID,
        overlap: 'queue',
        status: 'admitted',
        blocker: null,
        runStatus: null,
        blockerRunStatus: null,
        launch,
      });
      return null;
    },
    drainResourceStarts: async ({
      resource,
      hostId,
    }): ReturnType<IResourceStartStore['drainResourceStarts']> => {
      const admitted: ResourceStartDisposition[] = [];
      for (const { id } of drainableStarts(await occupancy(resource), hostId)) {
        const request = requests.get(id);
        if (!request) throw new Error('Queued resource request missing');
        await createRun(request.launch.run);
        request.status = 'admitted';
        request.blocker = null;
        admitted.push(decision(request));
      }
      return admitted;
    },
    hasStartReceiptForDelivery: async (sourceInstanceId, deliveryId) =>
      receiptForDelivery(sourceInstanceId, deliveryId) !== undefined,
    acceptStartReceipt: async (input): ReturnType<IResourceStartStore['acceptStartReceipt']> => {
      const previous =
        input.receipt.deliveryId === null
          ? receipts.get(input.receipt.id)
          : receiptForDelivery(input.receipt.sourceInstanceId, input.receipt.deliveryId);
      if (previous) {
        if (previous.contentDigest !== input.receipt.contentDigest)
          throw new SourceReceiptDigestConflictError();
        return { receiptId: previous.id, replay: true };
      }
      if (input.receipt.itemKey !== undefined) throw new Error('The test store has no items');
      receipts.set(input.receipt.id, {
        ...structuredClone(input.receipt),
        itemKey: null,
        outcome: input.outcome,
        reason: input.reason ?? null,
        bindings: [
          ...input.bindings.map(intent => ({
            receiptId: input.receipt.id,
            bindingId: intent.bindingId,
            bindingRevision: intent.bindingRevision,
            hostId: intent.hostId,
            status: 'pending' as const,
            ownerId: null,
            error: null,
            intent: structuredClone(intent),
            requestStatus: null,
            disposition: null,
          })),
          ...(input.evaluatedBindings ?? []).map(item => ({
            receiptId: input.receipt.id,
            bindingId: item.bindingId,
            bindingRevision: item.bindingRevision,
            hostId: null,
            status: item.status,
            ownerId: null,
            error: item.reason,
            intent: null,
            requestStatus: null,
            disposition: null,
          })),
        ],
      });
      return { receiptId: input.receipt.id, replay: false };
    },
    getStartReceipt: async (id): ReturnType<IResourceStartStore['getStartReceipt']> => {
      const receipt = receipts.get(id);
      return receipt ? inspectReceipt(receipt) : null;
    },
    listStartReceipts: async (
      limit?: number
    ): ReturnType<IResourceStartStore['listStartReceipts']> =>
      structuredClone(
        [...receipts.values()]
          .sort(compareStartReceipts)
          .slice(0, validateStartReceiptLimit(limit))
          .map(({ id, sourceInstanceId, deliveryId, outcome, reason, receivedAt }) => ({
            id,
            sourceInstanceId,
            deliveryId,
            outcome,
            reason,
            receivedAt,
          }))
      ),
    listPendingStartBindings: async ({
      hostId,
      limit = 100,
    }): ReturnType<IResourceStartStore['listPendingStartBindings']> =>
      structuredClone(
        [...receipts.values()]
          .flatMap(receipt => receipt.bindings)
          .filter(
            item =>
              item.hostId === hostId && (item.status === 'pending' || item.status === 'failed')
          )
          .slice(0, limit)
      ),
    getResourceStartRequest: async (
      id
    ): ReturnType<IResourceStartStore['getResourceStartRequest']> => {
      const request = requests.get(id);
      return request ? inspect(request) : null;
    },
    listQueuedResourceStartsForHost: async (
      hostId
    ): ReturnType<IResourceStartStore['listQueuedResourceStartsForHost']> =>
      Promise.all(
        [...requests.values()]
          .filter(item => item.hostId === hostId && item.status === 'queued')
          .map(inspect)
      ),
    withdrawQueuedResourceStart: async (
      id
    ): ReturnType<IResourceStartStore['withdrawQueuedResourceStart']> => {
      const request = requests.get(id);
      if (request?.status !== 'queued') return null;
      request.status = 'withdrawn';
      return structuredClone(request.launch);
    },
    claimStartBindingPreparation: async (
      input
    ): ReturnType<IResourceStartStore['claimStartBindingPreparation']> => {
      const item = binding(input);
      if (!item || (item.status !== 'pending' && item.status !== 'failed')) return false;
      item.status = 'preparing';
      item.ownerId = input.ownerId;
      return true;
    },
    completeStartBindingPreparation: async (
      input
    ): ReturnType<IResourceStartStore['completeStartBindingPreparation']> => {
      const item = owned(input);
      if (!item?.intent) return null;
      const result = await admit(preparedBindingStart(item.intent, input));
      item.status = 'complete';
      item.error = null;
      item.disposition = result;
      return result;
    },
    failStartBindingPreparation: async (
      input
    ): ReturnType<IResourceStartStore['failStartBindingPreparation']> => {
      const item = owned(input);
      if (!item) return false;
      item.status = input.retryable ? 'failed' : 'rejected';
      item.error = input.error;
      return true;
    },
    resetStartBindingPreparation: async (
      input
    ): ReturnType<IResourceStartStore['resetStartBindingPreparation']> => {
      const item = owned(input);
      if (!item) return false;
      item.status = 'pending';
      item.ownerId = null;
      return true;
    },
  };
}
