import { holdsWorkflowPath } from '../workflow-path-lock';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { createLogger } from '@archon/paths/logger';
import { isOwnerProvablyGone, parseProcessOwner } from '@archon/paths/process-owner';
import { isTerminalRunStatus, type WorkflowRun } from '../schemas/workflow-run';
import {
  preparedWorkflowLaunchSchema,
  resourceStartOverlapSchema,
  resourceStartRequestStatusSchema,
  startBindingPreparationStatusSchema,
  sourceReceiptOutcomeSchema,
  resourceStartBindingIntentSchema,
  resourceStartDispositionSchema,
  sourceReceiptInputSchema,
  sourceReceiptAcceptanceSchema,
  type ResourceStartIntent,
  type ResourceStartDisposition,
} from '../schemas/resource-start';
import {
  ResourceSlotCapacityConflictError,
  SourceReceiptDigestConflictError,
  capacityWaiters,
  drainableStarts,
  heldCheckouts,
  type ReusableCheckout,
  resourceResumeBlocker,
  resourceStartBlocker,
  type QueuedStart,
  type ResourceBlocker,
  type ResourceSlotOccupancy,
  validateStartReceiptLimit,
  compareStartReceipts,
  compareCodeUnits,
  type IResourceStartStore,
  type StartBindingInspection,
  type ResourceStartRequestInspection,
  type QueuedResourceStartInspection,
} from '../resource-start-store';
import { WorkflowNotResumableError } from '../store';
import {
  commit,
  isRunArchived,
  listRunSnapshots,
  readJson,
  readSnapshot,
  recoverBeforeRead,
} from './commit';
import { createTransactionView } from './transaction-view';

const log = createLogger('file-store.admission');

const slotMembershipSchema = z.object({
  holders: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('run'), id: z.string() }),
      z.object({ kind: z.literal('attempt'), id: z.string(), owner: z.unknown().optional() }),
    ])
  ),
  // Checkout membership survives giving back capacity while paused.
  admitted: z.array(z.string()).default([]),
});

/** `source` names the slot document in a malformed attempt owner's error. */
const slotSchema = (source: string) =>
  slotMembershipSchema.extend({
    capacity: z.number().int().positive(),
    holders: slotMembershipSchema.shape.holders.transform(holders =>
      holders.map(holder =>
        holder.kind === 'attempt'
          ? { ...holder, owner: parseProcessOwner(holder.owner, source) }
          : holder
      )
    ),
    queue: z.array(z.string()),
  });
const requestSchema = z.object({
  id: z.string(),
  resource: z.string(),
  hostId: z.string(),
  overlap: resourceStartOverlapSchema,
  status: resourceStartRequestStatusSchema,
  blocker: resourceStartDispositionSchema.options[1].shape.blocker.nullable(),
  launch: preparedWorkflowLaunchSchema,
  position: z.number().int().nonnegative(),
});
function queuedRequestSchema(id: string, slotPath: string) {
  return requestSchema.refine(
    row =>
      row.id === id &&
      row.launch.run.id === id &&
      row.status === 'queued' &&
      pathFor('slots', row.resource) === slotPath,
    { message: `Queued resource request '${id}' does not belong to resource slot '${slotPath}'` }
  );
}
const requestEnvelopeSchema = requestSchema.pick({ resource: true, status: true }).extend({
  status: z.literal('admitted'),
  launch: z.unknown(),
});
const bindingSchema = z.object({
  receiptId: z.string(),
  bindingId: z.string(),
  bindingRevision: z.string().nullable(),
  hostId: z.string().nullable(),
  status: startBindingPreparationStatusSchema,
  ownerId: z.string().nullable(),
  error: z.string().nullable(),
  intent: resourceStartBindingIntentSchema.nullable(),
  requestIds: z.array(z.string()),
});
const bindingInspectionSchema = bindingSchema.omit({ requestIds: true });
const receiptFieldsSchema = sourceReceiptInputSchema.strip();
const receiptSchema = sourceReceiptInputSchema.extend({
  outcome: sourceReceiptOutcomeSchema,
  reason: z.string().nullable(),
  bindings: z.array(bindingSchema),
  createdAt: z.string(),
});
type Request = z.infer<typeof requestSchema>;
const pathFor = (kind: string, key: string): string =>
  `resource/${kind}/${createHash('sha256').update(key).digest('hex')}.json`;
const deliveryPathFor = (sourceInstanceId: string, deliveryId: string): string =>
  pathFor('deliveries', JSON.stringify([sourceInstanceId, deliveryId]));
async function documentPaths(root: string, kind: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, 'resource', kind));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(name => name.endsWith('.json')).map(name => `resource/${kind}/${name}`);
}

function disposition(row: Request): ResourceStartDisposition {
  if (row.status === 'admitted') return { status: 'admitted', requestId: row.id, runId: row.id };
  if ((row.status === 'queued' || row.status === 'skipped') && row.blocker)
    return { status: row.status, requestId: row.id, blocker: row.blocker };
  throw new Error(`Resource start request '${row.id}' has no executable disposition`);
}

type Slot = z.infer<ReturnType<typeof slotSchema>>;
type Receipt = z.infer<typeof receiptSchema>;
type Binding = z.infer<typeof bindingSchema>;
interface BindingIdentity {
  receiptId: string;
  bindingId: string;
}
type PreparationOwner = BindingIdentity & { ownerId: string };
interface AdmissionTransaction {
  documents: Record<string, unknown>;
  changedDocuments(): Promise<Record<string, unknown>>;
  read<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S> | null>;
  request(id: string): Promise<Request | null>;
  receipt(id: string): Promise<Receipt | null>;
  slot(resource: string, capacity?: number): Promise<Slot>;
  occupancy(resource: string): Promise<ResourceSlotOccupancy>;
  admit(
    intent: ResourceStartIntent,
    runs: Map<string, WorkflowRun>
  ): Promise<ResourceStartDisposition>;
  admitExisting(row: Request, runs: Map<string, WorkflowRun>): Promise<ResourceStartDisposition>;
  binding(input: BindingIdentity): Promise<Binding | undefined>;
  owned(input: PreparationOwner): Promise<Binding | undefined>;
  canClaim(id: string): Promise<boolean>;
  /** Take a slot for an admitted failed or paused run's resume, or say what blocks it. */
  resume(run: WorkflowRun): Promise<ResourceBlocker | null>;
  /** Remove the run holder of an admitted run; whether one was removed. */
  release(id: string): Promise<boolean>;
}

// Used only inside commit: all holder reads and document changes share the run's lock.
export function createAdmissionTransaction(
  root: string,
  listReusableCheckouts: () => Promise<readonly ReusableCheckout[]> = async () => []
): AdmissionTransaction {
  const documents: Record<string, unknown> = {};
  const slots = new Map<string, Slot>();
  const receipts = new Map<string, z.infer<typeof receiptSchema>>();
  async function read<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S> | null> {
    const raw = path in documents ? documents[path] : await readJson(join(root, path));
    return raw === undefined ? null : schema.parse(raw);
  }
  const request = (id: string): Promise<Request | null> =>
    read(pathFor('requests', id), requestSchema);
  async function receipt(id: string): Promise<Receipt | null> {
    const row = receipts.get(id) ?? (await read(pathFor('receipts', id), receiptSchema));
    if (row) receipts.set(id, row);
    return row;
  }
  async function slot(resource: string, capacity?: number): Promise<Slot> {
    const path = pathFor('slots', resource);
    const schema = slotSchema(join(root, path));
    const row =
      slots.get(resource) ??
      (await read(path, schema)) ??
      schema.parse({ capacity: capacity ?? 1, holders: [], queue: [] });
    if (capacity !== undefined && row.capacity !== capacity)
      throw new ResourceSlotCapacityConflictError(resource, row.capacity, capacity);
    documents[path] = row;
    slots.set(resource, row);
    return row;
  }
  async function live(resource: string): Promise<Slot> {
    const row = await slot(resource);
    const holders: typeof row.holders = [];
    for (const holder of row.holders) {
      if (holder.kind === 'attempt') {
        if (!isOwnerProvablyGone(holder.owner)) holders.push(holder);
      } else {
        const run = await readSnapshot(root, holder.id);
        if (run && !isTerminalRunStatus(run.status)) holders.push(holder);
      }
    }
    row.holders = holders;
    return row;
  }
  async function hasForeignSlotMembership(id: string, resource: string): Promise<boolean> {
    for (const path of await documentPaths(root, 'slots')) {
      if (path === pathFor('slots', resource)) continue;
      try {
        const row = await read(path, slotMembershipSchema);
        if (
          row?.admitted.includes(id) ||
          row?.holders.some(holder => holder.kind === 'run' && holder.id === id)
        )
          return true;
      } catch (error) {
        throw new Error(`Invalid resource slot membership '${path}'`, { cause: error });
      }
    }
    return false;
  }
  async function occupancyRun(run: WorkflowRun, resource: string, local: boolean) {
    const knownForeign = !local && (await hasForeignSlotMembership(run.id, resource));
    try {
      const path = pathFor('requests', run.id);
      const raw = path in documents ? documents[path] : await readJson(join(root, path));
      if (local)
        return {
          kind: 'local' as const,
          run: {
            ...run,
            launch: requestSchema
              .extend({ resource: z.literal(resource), status: z.literal('admitted') })
              .parse(raw).launch,
          },
        };
      const envelope = raw === undefined ? null : requestEnvelopeSchema.parse(raw);
      if (!knownForeign && envelope?.resource === resource && capacityWaiters([run]).length > 0) {
        const row = requestSchema
          .refine(row => row.id === run.id && row.launch.run.id === run.id, {
            message: `Admitted resource request '${run.id}' does not identify the waiting run`,
          })
          .parse(raw);
        return { kind: 'local' as const, run: { ...run, launch: row.launch } };
      }
      // Without a capacity refusal, old released slots have no independent membership.
      // A readable envelope alone cannot establish capacity membership.
      if (!knownForeign && envelope)
        return {
          kind: 'unknown' as const,
          run: { ...run, launch: preparedWorkflowLaunchSchema.parse(envelope.launch) },
        };
      if (!holdsWorkflowPath(run)) return null;
      const launch = envelope ? preparedWorkflowLaunchSchema.parse(envelope.launch) : undefined;
      return {
        kind: 'foreign' as const,
        run: { ...run, launch },
        unknown: knownForeign && !launch && !run.working_path,
      };
    } catch (error) {
      if (local) throw error;
      return corruptForeignOccupancy(run, knownForeign, error);
    }
  }
  async function corruptForeignOccupancy(run: WorkflowRun, knownForeign: boolean, error: unknown) {
    if (!(error instanceof z.ZodError || error instanceof SyntaxError)) throw error;
    if (!holdsWorkflowPath(run)) return null;
    // A released paused run may still be local. Only proven foreign membership
    // permits the corruption fallback, which allows read-only concurrency.
    if (!knownForeign) throw error;
    // Corrupt foreign requests still hold their recorded path and registered aliases.
    // Without a path, guarded starts must wait for the holder to end.
    log.error(
      { runId: run.id },
      run.working_path
        ? 'foreign_request_invalid_using_working_path'
        : 'foreign_request_invalid_checkout_unknown'
    );
    return { kind: 'foreign' as const, run, unknown: !run.working_path };
  }

  // Paused runs, and so waiters, live only on run rows: finding them scans every run, as
  // the due scan does.
  async function occupancy(resource: string): Promise<ResourceSlotOccupancy> {
    const row = await live(resource);
    const admittedRuns: (WorkflowRun & { launch: Request['launch'] })[] = [];
    const foreign: (WorkflowRun & { launch?: Request['launch'] })[] = [];
    const possiblyLocal: (WorkflowRun & { launch: Request['launch'] })[] = [];
    const runs = (await listRunSnapshots(root)).sort(
      (a, b) => a.started_at.getTime() - b.started_at.getTime() || compareCodeUnits(a.id, b.id)
    );
    let unknownForeignCheckoutHolder: string | undefined;
    for (const run of runs) {
      if (isTerminalRunStatus(run.status)) continue;
      const holder = await occupancyRun(
        run,
        resource,
        row.admitted.includes(run.id) ||
          row.holders.some(holder => holder.kind === 'run' && holder.id === run.id)
      );
      if (holder?.kind === 'local') {
        admittedRuns.push(holder.run);
        possiblyLocal.push(holder.run);
      } else if (holder?.kind === 'unknown') possiblyLocal.push(holder.run);
      else if (holder) {
        foreign.push(holder.run);
        if (holder.unknown) unknownForeignCheckoutHolder ??= run.id;
      }
    }
    const queue: QueuedStart[] = [];
    for (const id of row.queue) {
      const queued = await request(id);
      if (!queued) throw new Error('Queued resource request missing');
      queue.push(queuedRequestSchema(id, pathFor('slots', resource)).parse(queued));
    }
    const reusable = await listReusableCheckouts();
    return {
      capacity: row.capacity,
      reusableCheckouts: reusable,
      holders: row.holders,
      waiters: capacityWaiters(
        admittedRuns.filter(run => !row.holders.some(h => h.kind === 'run' && h.id === run.id))
      ),
      queue,
      heldCheckouts: heldCheckouts(possiblyLocal, reusable),
      foreignHeldCheckouts: heldCheckouts(foreign, reusable),
      unknownForeignCheckoutHolder,
    };
  }
  async function admitExisting(
    row: Request,
    runs: Map<string, WorkflowRun>
  ): Promise<ResourceStartDisposition> {
    // A deleted run's ID stays reserved, as in createWorkflowRun.
    if (
      runs.has(row.id) ||
      (await readSnapshot(root, row.id)) ||
      (await isRunArchived(root, row.id))
    )
      throw new Error(`Run already exists: ${row.id}`);
    await createTransactionView(runs, [], async () => null).createWorkflowRun(row.launch.run);
    row.status = 'admitted';
    row.blocker = null;
    const resource = await slot(row.resource);
    resource.queue = resource.queue.filter(id => id !== row.id);
    resource.holders.push({ kind: 'run', id: row.id });
    if (!resource.admitted.includes(row.id)) resource.admitted.push(row.id);
    documents[pathFor('requests', row.id)] = row;
    return disposition(row);
  }
  async function admit(
    intent: ResourceStartIntent,
    runs: Map<string, WorkflowRun>
  ): Promise<ResourceStartDisposition> {
    const resource = await slot(intent.resource, intent.capacity);
    const previous = await request(intent.launch.run.id);
    if (previous) return disposition(previous);
    const launch = preparedWorkflowLaunchSchema.parse(intent.launch);
    const blocker = resourceStartBlocker(await occupancy(intent.resource), launch);
    const head = z.object({ seq: z.number() }).parse(await readJson(join(root, 'head.json')));
    const row: Request = {
      id: intent.launch.run.id,
      resource: intent.resource,
      hostId: intent.hostId,
      overlap: intent.overlap,
      status: blocker && intent.overlap === 'skip' ? 'skipped' : 'queued',
      blocker,
      launch,
      position: head.seq + 1,
    };
    documents[pathFor('requests', row.id)] = row;
    if (intent.receipt) {
      const item = await binding(intent.receipt);
      if (!item) throw new Error('Resource start receipt binding missing');
      item.requestIds.push(row.id);
    }
    if (!blocker) return admitExisting(row, runs);
    if (row.status === 'queued') resource.queue.push(row.id);
    return disposition(row);
  }
  async function binding(input: BindingIdentity): Promise<Binding | undefined> {
    const row = await receipt(input.receiptId);
    const item = row?.bindings.find(item => item.bindingId === input.bindingId);
    if (row && item) documents[pathFor('receipts', row.id)] = row;
    return item;
  }
  async function owned(input: PreparationOwner): Promise<Binding | undefined> {
    const item = await binding(input);
    return item?.status === 'preparing' && item.ownerId === input.ownerId ? item : undefined;
  }
  async function canClaim(id: string): Promise<boolean> {
    const row = await request(id);
    if (!row) return true;
    return (
      row.status === 'admitted' &&
      (await slot(row.resource)).holders.some(h => h.kind === 'run' && h.id === id)
    );
  }
  async function resume(run: WorkflowRun): Promise<ResourceBlocker | null> {
    const row = await request(run.id);
    if (row?.status !== 'admitted') return null;
    if (row.id !== run.id || row.launch.run.id !== run.id)
      throw new Error(`Admitted resource request '${run.id}' does not identify the resumed run`);
    const resource = await slot(row.resource);
    if (await hasForeignSlotMembership(run.id, row.resource))
      throw new Error(`Admitted resource request '${run.id}' disagrees with its slot membership`);
    if (run.status !== 'failed' && run.status !== 'paused')
      throw new WorkflowNotResumableError(run.id, run.status);
    if (!resource.admitted.includes(run.id)) resource.admitted.push(run.id);
    const blocker = resourceResumeBlocker(await occupancy(row.resource), {
      ...run,
      status: run.status,
    });
    if (blocker) return blocker;
    if (!resource.holders.some(h => h.kind === 'run' && h.id === run.id))
      resource.holders.push({ kind: 'run', id: run.id });
    return null;
  }
  async function release(id: string): Promise<boolean> {
    const row = await request(id);
    if (row?.status !== 'admitted') return false;
    const resource = await slot(row.resource);
    const holders = resource.holders.filter(h => h.kind !== 'run' || h.id !== id);
    if (holders.length === resource.holders.length) return false;
    if (!resource.admitted.includes(id)) resource.admitted.push(id);
    resource.holders = holders;
    return true;
  }
  async function changedDocuments(): Promise<Record<string, unknown>> {
    const changed: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(documents)) {
      if (!isDeepStrictEqual(await readJson(join(root, path)), JSON.parse(JSON.stringify(value))))
        changed[path] = value;
    }
    return changed;
  }
  return {
    documents,
    changedDocuments,
    read,
    request,
    receipt,
    slot,
    occupancy,
    admit,
    admitExisting,
    binding,
    owned,
    canClaim,
    resume,
    release,
  };
}

export function createFileAdmissionStore(
  root: string,
  listReusableCheckouts?: () => Promise<readonly ReusableCheckout[]>
): IResourceStartStore {
  type Transaction = ReturnType<typeof createAdmissionTransaction>;
  const write = <T>(
    call: (tx: Transaction, runs: Map<string, WorkflowRun>) => Promise<T>
  ): Promise<T> =>
    commit(root, [], async runs => {
      const tx = createAdmissionTransaction(root, listReusableCheckouts);
      const result = await call(tx, runs);
      return {
        result,
        changes: {
          documents: await tx.changedDocuments(),
          runs: [...runs.values()].map(run => ({ run })),
        },
      };
    });
  async function query<T>(call: (tx: Transaction) => Promise<T>): Promise<T> {
    await recoverBeforeRead(root);
    return call(createAdmissionTransaction(root, listReusableCheckouts));
  }
  async function list<S extends z.ZodType>(kind: string, schema: S): Promise<z.output<S>[]> {
    const rows: z.output<S>[] = [];
    for (const path of await documentPaths(root, kind))
      rows.push(schema.parse(await readJson(join(root, path))));
    return rows;
  }
  async function queueCandidate<S extends z.ZodType>(
    path: string,
    schema: S
  ): Promise<{ data: z.output<S> } | { error: Error }> {
    try {
      return { data: schema.parse(await readJson(join(root, path))) };
    } catch (error) {
      if (!(error instanceof z.ZodError || error instanceof SyntaxError)) throw error;
      return { error: new Error(`Invalid queued document '${path}'`, { cause: error }) };
    }
  }
  async function receiptIdForRequest(id: string): Promise<string | undefined> {
    const schema = receiptSchema
      .pick({ id: true })
      .strip()
      .extend({
        bindings: z.array(bindingSchema.pick({ requestIds: true })),
      });
    for (const path of await documentPaths(root, 'receipts')) {
      const receipt = await queueCandidate(path, schema);
      if ('error' in receipt) {
        log.error({ document: path }, 'queued_start_receipt_invalid_attribution_unknown');
        continue;
      }
      if (receipt.data.bindings.some(binding => binding.requestIds.includes(id)))
        return receipt.data.id;
    }
    return undefined;
  }
  async function inspectQueuedRequest(
    slotPath: string,
    id: string,
    resource: unknown,
    position: number
  ) {
    const path = pathFor('requests', id);
    try {
      const row = queuedRequestSchema(id, slotPath).parse(await readJson(join(root, path)));
      return { inspection: await inspect(row), position: row.position };
    } catch (error) {
      return {
        inspection: {
          id,
          receiptId: await receiptIdForRequest(id),
          resource:
            typeof resource === 'string' && pathFor('slots', resource) === slotPath
              ? resource
              : undefined,
          error: new Error(`Invalid queued request document '${path}'`, { cause: error }),
        },
        position,
      };
    }
  }
  async function inspect(row: Request): Promise<ResourceStartRequestInspection> {
    return {
      id: row.id,
      resource: row.resource,
      hostId: row.hostId,
      overlap: row.overlap,
      status: row.status,
      blocker: row.blocker,
      launch: row.launch,
      runStatus: (await readSnapshot(root, row.id))?.status ?? null,
      blockerRunStatus:
        row.blocker?.kind === 'run'
          ? ((await readSnapshot(root, row.blocker.id))?.status ?? null)
          : null,
    };
  }
  async function inspectBinding(
    tx: Transaction,
    item: z.infer<typeof bindingSchema>,
    requestId: string | null = null
  ): Promise<StartBindingInspection> {
    const inspection = bindingInspectionSchema.parse(item);
    const request = requestId ? await tx.request(requestId) : null;
    return {
      ...inspection,
      requestStatus: request?.status ?? null,
      disposition: request && request.status !== 'withdrawn' ? disposition(request) : null,
    };
  }
  return {
    admitResourceStart: intent => write((tx, runs) => tx.admit(intent, runs)),
    drainResourceStarts: options =>
      write(async (tx, runs) => {
        const admitted: ResourceStartDisposition[] = [];
        for (const start of drainableStarts(await tx.occupancy(options.resource), options.hostId)) {
          const row = await tx.request(start.id);
          if (!row) throw new Error('Queued resource request missing');
          admitted.push(await tx.admitExisting(row, runs));
        }
        return admitted;
      }),
    acceptStartReceipt: input =>
      write(async tx => {
        sourceReceiptAcceptanceSchema.parse(input);
        const deliveryPath =
          input.receipt.deliveryId === null
            ? null
            : deliveryPathFor(input.receipt.sourceInstanceId, input.receipt.deliveryId);
        const previousId = deliveryPath ? await tx.read(deliveryPath, z.string()) : null;
        const existing = await tx.receipt(input.receipt.id);
        if (existing || previousId) {
          const prior = previousId ? await tx.receipt(previousId) : null;
          if (!prior) throw new Error(`Source receipt id '${input.receipt.id}' already exists`);
          if (prior.contentDigest !== input.receipt.contentDigest)
            throw new SourceReceiptDigestConflictError(
              'Delivery identity was reused with different verified content'
            );
          return { receiptId: prior.id, replay: true };
        }
        const row: z.infer<typeof receiptSchema> = {
          ...input.receipt,
          outcome: input.outcome,
          reason: input.reason ?? null,
          createdAt: new Date().toISOString(),
          bindings: [
            ...input.bindings.map(intent => ({
              receiptId: input.receipt.id,
              bindingId: intent.bindingId,
              bindingRevision: intent.bindingRevision,
              hostId: intent.hostId,
              status: 'pending' as const,
              ownerId: null,
              error: null,
              intent,
              requestIds: [],
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
              requestIds: [],
            })),
          ],
        };
        receiptSchema.parse(row);
        tx.documents[pathFor('receipts', row.id)] = row;
        if (deliveryPath) tx.documents[deliveryPath] = row.id;
        return { receiptId: row.id, replay: false };
      }),
    hasStartReceiptForDelivery: (sourceInstanceId, deliveryId) =>
      query(
        async tx =>
          (await tx.read(deliveryPathFor(sourceInstanceId, deliveryId), z.string())) !== null
      ),
    getStartReceipt: id =>
      query(async tx => {
        const row = await tx.receipt(id);
        return row
          ? {
              ...receiptFieldsSchema.parse(row),
              outcome: row.outcome,
              reason: row.reason,
              bindings: await Promise.all(
                [...row.bindings]
                  .sort((a, b) => compareCodeUnits(a.bindingId, b.bindingId))
                  .flatMap(item =>
                    (item.requestIds.length ? item.requestIds : [null]).map(requestId =>
                      inspectBinding(tx, item, requestId)
                    )
                  )
              ),
            }
          : null;
      }),
    listStartReceipts: limit =>
      query(async () =>
        (await list('receipts', receiptSchema))
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
    listPendingStartBindings: options =>
      query(async tx => {
        const rows = (await list('receipts', receiptSchema)).flatMap(receipt =>
          receipt.bindings.map(binding => ({ binding, createdAt: receipt.createdAt }))
        );
        return Promise.all(
          rows
            .filter(
              ({ binding }) =>
                binding.hostId === options.hostId &&
                (binding.status === 'pending' || binding.status === 'failed')
            )
            .sort(
              (a, b) =>
                compareCodeUnits(a.createdAt, b.createdAt) ||
                compareCodeUnits(a.binding.bindingId, b.binding.bindingId)
            )
            .slice(0, options.limit ?? 100)
            .map(({ binding }) => inspectBinding(tx, binding))
        );
      }),
    getResourceStartRequest: id =>
      query(async tx => {
        const row = await tx.request(id);
        return row ? inspect(row) : null;
      }),
    listQueuedResourceStartsForHost: hostId =>
      query(async () => {
        const queued: { inspection: QueuedResourceStartInspection; position: number }[] = [];
        for (const path of await documentPaths(root, 'slots')) {
          const slot = await queueCandidate(path, slotSchema(path).pick({ queue: true }));
          if ('error' in slot) {
            queued.push({ inspection: { id: path, error: slot.error }, position: 0 });
            continue;
          }
          for (const [position, id] of slot.data.queue.entries()) {
            const envelope = await queueCandidate(
              pathFor('requests', id),
              requestSchema.pick({ hostId: true }).extend({ resource: z.unknown().optional() })
            );
            if ('error' in envelope) {
              queued.push({ inspection: { id, error: envelope.error }, position });
              continue;
            }
            if (envelope.data.hostId !== hostId) continue;
            queued.push(await inspectQueuedRequest(path, id, envelope.data.resource, position));
          }
        }
        queued.sort(
          (a, b) =>
            compareCodeUnits(a.inspection.resource ?? '', b.inspection.resource ?? '') ||
            a.position - b.position
        );
        return queued.map(row => row.inspection);
      }),
    withdrawQueuedResourceStart: id =>
      write(async tx => {
        const row = await tx.request(id);
        if (row?.status !== 'queued') return null;
        row.status = 'withdrawn';
        tx.documents[pathFor('requests', id)] = row;
        const resource = await tx.slot(row.resource);
        resource.queue = resource.queue.filter(key => key !== id);
        return row.launch;
      }),
    claimStartBindingPreparation: input =>
      write(async tx => {
        const item = await tx.binding(input);
        if (!item || (item.status !== 'pending' && item.status !== 'failed')) return false;
        item.status = 'preparing';
        item.ownerId = input.ownerId;
        return true;
      }),
    completeStartBindingPreparation: input =>
      write(async (tx, runs) => {
        const item = await tx.owned(input);
        if (!item?.intent) return null;
        const result = await tx.admit(
          {
            ...item.intent,
            launch: input.launch,
            receipt: { receiptId: input.receiptId, bindingId: input.bindingId },
          },
          runs
        );
        item.status = 'complete';
        item.error = null;
        return result;
      }),
    failStartBindingPreparation: input =>
      write(async tx => {
        const item = await tx.owned(input);
        if (!item) return false;
        item.status = input.retryable ? 'failed' : 'rejected';
        item.error = input.error;
        return true;
      }),
    resetStartBindingPreparation: input =>
      write(async tx => {
        const item = await tx.owned(input);
        if (!item) return false;
        item.status = 'pending';
        item.ownerId = null;
        return true;
      }),
  };
}
