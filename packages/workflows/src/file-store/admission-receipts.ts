import {
  bindingSchema,
  deliveryPathFor,
  pathFor,
  receiptFieldsSchema,
  receiptSchema,
  type Binding,
} from './admission-documents';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkflowRun } from '../schemas/workflow-run';
import {
  sourceReceiptAcceptanceSchema,
  startBindingInspectionSchema,
} from '../schemas/resource-start';
import {
  SourceReceiptDigestConflictError,
  compareCodeUnits,
  compareStartReceipts,
  preparedBindingStart,
  validateStartReceiptLimit,
  type DamagedStartReceipt,
  type IResourceStartStore,
  type StartBindingInspection,
} from '../resource-start-store';
import { readJson } from './commit';
import { FileStoreUnsupportedError } from './errors';
import { disposition, documentPaths, type AdmissionTransaction } from './admission-transaction';

export type AdmissionWrite = <T>(
  call: (tx: AdmissionTransaction, runs: Map<string, WorkflowRun>) => Promise<T>
) => Promise<T>;
export type AdmissionQuery = <T>(call: (tx: AdmissionTransaction) => Promise<T>) => Promise<T>;

type ReceiptOperations = Pick<
  IResourceStartStore,
  | 'acceptStartReceipt'
  | 'hasStartReceiptForDelivery'
  | 'getStartReceipt'
  | 'listStartReceipts'
  | 'listPendingStartBindings'
  | 'claimStartBindingPreparation'
  | 'completeStartBindingPreparation'
  | 'failStartBindingPreparation'
  | 'resetStartBindingPreparation'
  | 'replaceStartBindingIntent'
  | 'returnQueuedStartToPreparation'
>;

/** The file admission store's source receipts and the start bindings each one records. */
export function createReceiptOperations(
  root: string,
  write: AdmissionWrite,
  query: AdmissionQuery
): ReceiptOperations {
  async function list<S extends z.ZodType>(kind: string, schema: S): Promise<z.output<S>[]> {
    const rows: z.output<S>[] = [];
    for (const path of await documentPaths(root, kind))
      rows.push(schema.parse(await readJson(join(root, path))));
    return rows;
  }
  async function inspectBinding(
    tx: AdmissionTransaction,
    item: z.infer<typeof bindingSchema>,
    requestId: string | null = null
  ): Promise<StartBindingInspection> {
    // Rejoin the overrides the stored document keeps beside the intent (see `bindingSchema`).
    const { startOverrides, ...stored } = item;
    const inspection = startBindingInspectionSchema.parse({
      ...stored,
      intent: item.intent && startOverrides ? { ...item.intent, startOverrides } : item.intent,
    });
    const request = requestId ? await tx.request(requestId) : null;
    return {
      ...inspection,
      requestStatus: request?.status ?? null,
      disposition: request && request.status !== 'withdrawn' ? disposition(request) : null,
    };
  }
  return {
    acceptStartReceipt: input =>
      write(async tx => {
        sourceReceiptAcceptanceSchema.parse(input);
        if (
          input.receipt.itemKey !== undefined ||
          input.bindings.some(
            binding => binding.itemKey !== undefined || binding.wake !== undefined
          )
        )
          throw new FileStoreUnsupportedError('items');
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
            ...input.bindings.map(intent => {
              const { startOverrides, ...storedIntent } = intent;
              return {
                receiptId: input.receipt.id,
                bindingId: intent.bindingId,
                bindingRevision: intent.bindingRevision,
                hostId: intent.hostId,
                status: 'pending' as const,
                ownerId: null,
                error: null,
                forgeRefusal: null,
                intent: storedIntent,
                startOverrides: startOverrides ?? null,
                requestIds: [],
              };
            }),
            ...(input.evaluatedBindings ?? []).map(item => ({
              receiptId: input.receipt.id,
              bindingId: item.bindingId,
              bindingRevision: item.bindingRevision,
              hostId: null,
              status: item.status,
              ownerId: null,
              error: item.reason,
              forgeRefusal: null,
              intent: null,
              startOverrides: null,
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
              itemKey: null,
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
            // The file store refuses a receipt that names an item.
            itemKey: null,
            outcome,
            reason,
            receivedAt,
          }))
      ),
    listPendingStartBindings: options =>
      query(async tx => {
        // Each receipt is read on its own: one damaged document must not hide every host's
        // pending bindings.
        const damaged: DamagedStartReceipt[] = [];
        const rows: { binding: Binding; createdAt: string }[] = [];
        const wanted = options.receiptIds && new Set(options.receiptIds);
        for (const path of await documentPaths(root, 'receipts')) {
          let receipt: z.output<typeof receiptSchema>;
          try {
            receipt = receiptSchema.parse(await readJson(join(root, path)));
          } catch (error) {
            if (wanted) continue;
            damaged.push({
              document: path,
              error: new Error(`Invalid start receipt document '${path}'`, { cause: error }),
            });
            continue;
          }
          if (wanted && !wanted.has(receipt.id)) continue;
          for (const binding of receipt.bindings)
            rows.push({ binding, createdAt: receipt.createdAt });
        }
        const bindings = await Promise.all(
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
        return [...damaged, ...bindings];
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
        // A limit counts per item, and this store keeps no items: refused, never let through.
        if (item.intent.limit !== undefined) {
          const reason = `Start limit '${item.intent.limit.name}' counts starts per item, and the file store keeps no items.`;
          item.status = 'rejected';
          item.error = reason;
          item.forgeRefusal = null;
          return { status: 'refused' as const, reason };
        }
        const result = await tx.admit(preparedBindingStart(item.intent, input), runs);
        item.status = 'complete';
        item.error = null;
        item.forgeRefusal = null;
        return result;
      }),
    failStartBindingPreparation: input =>
      write(async tx => {
        const item = await tx.owned(input);
        if (!item) return false;
        item.status = input.retryable ? 'failed' : 'rejected';
        item.error = input.error;
        item.forgeRefusal = input.forgeRefusal ?? null;
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
    replaceStartBindingIntent: input =>
      write(async tx => {
        const item = await tx.owned(input);
        if (!item?.intent) return false;
        // The recorded hand-off is kept, as the database store keeps its column.
        const { checkoutFrom } = item.intent;
        const { checkoutFrom: _replaced, ...intent } = input.intent;
        item.intent = checkoutFrom ? { ...intent, checkoutFrom } : intent;
        item.bindingRevision = input.intent.bindingRevision;
        item.hostId = input.intent.hostId;
        return true;
      }),
    returnQueuedStartToPreparation: input =>
      write(async tx => {
        const row = await tx.request(input.requestId);
        const item = await tx.binding(input);
        if (row?.status !== 'queued' || !item?.requestIds.includes(row.id)) return null;
        if (item.status !== 'complete')
          throw new Error(
            `Binding '${input.bindingId}' of receipt '${input.receiptId}' is not complete; request '${input.requestId}' stays queued`
          );
        // Withdrawn and dropped from the binding, so its next preparation is its one disposition.
        row.status = 'withdrawn';
        tx.documents[pathFor('requests', row.id)] = row;
        const slot = await tx.slot(row.resource);
        slot.queue = slot.queue.filter(id => id !== row.id);
        item.requestIds = item.requestIds.filter(id => id !== row.id);
        item.status = 'pending';
        item.ownerId = null;
        return row.launch;
      }),
  };
}
