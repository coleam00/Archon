import {
  queuedRequestSchema,
  requestSchema,
  receiptSchema,
  bindingSchema,
  slotSchema,
  pathFor,
  type Request,
} from './admission-documents';
import { join } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@archon/paths/logger';
import type { ResourceStartDisposition } from '../schemas/resource-start';
import {
  drainableStarts,
  compareCodeUnits,
  type ReusableCheckout,
  type IResourceStartStore,
  type ResourceStartRequestInspection,
  type QueuedResourceStartInspection,
} from '../resource-start-store';
import { commit, readJson, readSnapshot, recoverBeforeRead } from './commit';
import { createAdmissionTransaction, documentPaths } from './admission-transaction';
import {
  createReceiptOperations,
  type AdmissionQuery,
  type AdmissionWrite,
} from './admission-receipts';

const log = createLogger('file-store.admission');

export function createFileAdmissionStore(
  root: string,
  listReusableCheckouts?: () => Promise<readonly ReusableCheckout[]>
): IResourceStartStore {
  const write: AdmissionWrite = call =>
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
  const query: AdmissionQuery = async call => {
    await recoverBeforeRead(root);
    return call(createAdmissionTransaction(root, listReusableCheckouts));
  };
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
    ...createReceiptOperations(root, write, query),
  };
}
