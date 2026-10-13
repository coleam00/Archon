import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { isOwnerProvablyGone, type ProcessOwner } from '@archon/paths/process-owner';
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
  validateStartReceiptLimit,
  compareStartReceipts,
  type IResourceStartStore,
  type StartBindingInspection,
  type ResourceStartRequestInspection,
} from '../resource-start-store';
import { WorkflowNotResumableError, WorkflowResourceBusyError } from '../store';
import { commit, isRunArchived, readJson, readSnapshot, recoverBeforeRead } from './commit';
import { createTransactionView } from './transaction-view';

const ownerSchema = z.object({
  host: z.string(),
  pid: z.number().int(),
  instance: z.string(),
}) satisfies z.ZodType<ProcessOwner>;
const holderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), id: z.string() }),
  z.object({ kind: z.literal('attempt'), id: z.string(), owner: ownerSchema }),
]);
const slotSchema = z.object({
  capacity: z.number().int().positive(),
  holders: z.array(holderSchema),
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
function disposition(row: Request): ResourceStartDisposition {
  if (row.status === 'admitted') return { status: 'admitted', requestId: row.id, runId: row.id };
  if ((row.status === 'queued' || row.status === 'skipped') && row.blocker)
    return { status: row.status, requestId: row.id, blocker: row.blocker };
  throw new Error(`Resource start request '${row.id}' has no executable disposition`);
}

type Slot = z.infer<typeof slotSchema>;
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
  live(resource: string, capacity?: number): Promise<Slot>;
  admit(
    intent: ResourceStartIntent,
    runs: Map<string, WorkflowRun>
  ): Promise<ResourceStartDisposition>;
  admitExisting(row: Request, runs: Map<string, WorkflowRun>): Promise<ResourceStartDisposition>;
  binding(input: BindingIdentity): Promise<Binding | undefined>;
  owned(input: PreparationOwner): Promise<Binding | undefined>;
  canClaim(id: string): Promise<boolean>;
  resume(run: WorkflowRun): Promise<void>;
}

// Used only inside commit: all holder reads and document changes share the run's lock.
export function createAdmissionTransaction(root: string): AdmissionTransaction {
  const documents: Record<string, unknown> = {};
  const slots = new Map<string, z.infer<typeof slotSchema>>();
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
    const row =
      slots.get(resource) ??
      (await read(path, slotSchema)) ??
      slotSchema.parse({ capacity: capacity ?? 1, holders: [], queue: [] });
    if (capacity !== undefined && row.capacity !== capacity)
      throw new ResourceSlotCapacityConflictError(resource, row.capacity, capacity);
    documents[path] = row;
    slots.set(resource, row);
    return row;
  }
  async function live(resource: string, capacity?: number): Promise<Slot> {
    const row = await slot(resource, capacity);
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
    await live(intent.resource);
    const older = resource.queue[0];
    const first = resource.holders[0];
    const blocker: Request['blocker'] = older
      ? { kind: 'request', id: older }
      : resource.holders.length >= resource.capacity && first
        ? { kind: 'run', id: first.id }
        : null;
    const head = z.object({ seq: z.number() }).parse(await readJson(join(root, 'head.json')));
    const row: Request = {
      id: intent.launch.run.id,
      resource: intent.resource,
      hostId: intent.hostId,
      overlap: intent.overlap,
      status: blocker && intent.overlap === 'skip' ? 'skipped' : 'queued',
      blocker,
      launch: preparedWorkflowLaunchSchema.parse(intent.launch),
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
  async function resume(run: WorkflowRun): Promise<void> {
    const row = await request(run.id);
    if (row?.status !== 'admitted') return;
    if (run.status !== 'failed' && run.status !== 'paused')
      throw new WorkflowNotResumableError(run.id, run.status);
    const resource = await live(row.resource);
    const others = resource.holders.filter(holder => holder.id !== run.id);
    if (others.length >= resource.capacity && others[0])
      throw new WorkflowResourceBusyError(run.id, { kind: 'run', id: others[0].id });
    if (run.status === 'failed' && resource.queue[0])
      throw new WorkflowResourceBusyError(run.id, { kind: 'request', id: resource.queue[0] });
    if (!resource.holders.some(h => h.kind === 'run' && h.id === run.id))
      resource.holders.push({ kind: 'run', id: run.id });
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
    live,
    admit,
    admitExisting,
    binding,
    owned,
    canClaim,
    resume,
  };
}

export function createFileAdmissionStore(root: string): IResourceStartStore {
  type Transaction = ReturnType<typeof createAdmissionTransaction>;
  const write = <T>(
    call: (tx: Transaction, runs: Map<string, WorkflowRun>) => Promise<T>
  ): Promise<T> =>
    commit(root, [], async runs => {
      const tx = createAdmissionTransaction(root);
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
    return call(createAdmissionTransaction(root));
  }
  async function list<S extends z.ZodType>(kind: string, schema: S): Promise<z.output<S>[]> {
    let names: string[];
    try {
      names = await readdir(join(root, 'resource', kind));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const rows: z.output<S>[] = [];
    for (const name of names.filter(name => name.endsWith('.json')))
      rows.push(schema.parse(await readJson(join(root, 'resource', kind, name))));
    return rows;
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
        const resource = await tx.live(options.resource);
        const admitted: ResourceStartDisposition[] = [];
        while (resource.holders.length < resource.capacity && resource.queue[0]) {
          const row = await tx.request(resource.queue[0]);
          if (!row) throw new Error('Queued resource request missing');
          if (row.hostId !== options.hostId) break;
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
            : pathFor(
                'deliveries',
                JSON.stringify([input.receipt.sourceInstanceId, input.receipt.deliveryId])
              );
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
                  .sort((a, b) => a.bindingId.localeCompare(b.bindingId))
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
                a.createdAt.localeCompare(b.createdAt) ||
                a.binding.bindingId.localeCompare(b.binding.bindingId)
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
      query(async () =>
        Promise.all(
          (await list('requests', requestSchema))
            .filter(row => row.hostId === hostId && row.status === 'queued')
            .sort((a, b) => a.resource.localeCompare(b.resource) || a.position - b.position)
            .map(inspect)
        )
      ),
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
