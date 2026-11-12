import { join } from 'node:path';
import { z } from 'zod';
import {
  admissionNoticeCursor,
  admissionNoticeFactsSchema,
  validateAdmissionNoticeLimit,
  type AdmissionNoticeCursor,
  type AdmissionNoticeFacts,
} from '../admission-notice';
import { compareCodeUnits, type IResourceStartStore } from '../resource-start-store';
import { WorkflowEventCursorError } from '../store';
import { receiptSchema, requestSchema, pathFor } from './admission-documents';
import { documentPaths } from './admission-transaction';
import { readJson, readFileStoreHead, recoverFileStoreLocked } from './commit';
import { withFileStoreLock } from './lock';

const positionSchema = z.tuple([z.number().int().nonnegative().safe(), z.string().nullable()]);
type Position = z.infer<typeof positionSchema>;
const cursor = (position: Position): AdmissionNoticeCursor =>
  admissionNoticeCursor(`file-admission:${JSON.stringify(position)}`);

function position(after: AdmissionNoticeCursor | null): Position {
  if (after === null) return [0, null];
  try {
    if (!after.startsWith('file-admission:')) throw new WorkflowEventCursorError();
    return positionSchema.parse(JSON.parse(after.slice('file-admission:'.length)));
  } catch {
    throw new WorkflowEventCursorError();
  }
}

function compare(a: Position, b: Position): number {
  return (
    a[0] - b[0] ||
    (a[1] === b[1] ? 0 : a[1] === null ? 1 : b[1] === null ? -1 : compareCodeUnits(a[1], b[1]))
  );
}

type AdmissionNoticeReader = Pick<
  IResourceStartStore,
  'getAdmissionNoticeHead' | 'readAdmissionNoticesAfter'
>;

export function createFileAdmissionNoticeReader(root: string): AdmissionNoticeReader {
  return {
    getAdmissionNoticeHead: () =>
      withFileStoreLock(root, async () => {
        await recoverFileStoreLocked(root);
        return cursor([await readFileStoreHead(root), null]);
      }),
    readAdmissionNoticesAfter: async (after, { limit }) => {
      validateAdmissionNoticeLimit(limit);
      const lower = position(after);
      return withFileStoreLock(root, async () => {
        await recoverFileStoreLocked(root);
        const upper: Position = [await readFileStoreHead(root), null];
        if (compare(lower, upper) > 0) throw new WorkflowEventCursorError();
        const rows: { position: Position; facts: AdmissionNoticeFacts }[] = [];
        for (const path of await documentPaths(root, 'receipts')) {
          const receipt = receiptSchema.parse(await readJson(join(root, path)));
          if (receipt.deliveryId === null) continue;
          for (const binding of receipt.bindings) {
            for (const id of binding.requestIds) {
              const request = requestSchema.parse(
                await readJson(join(root, pathFor('requests', id)))
              );
              const at: Position = [request.position, request.id];
              if (request.status !== 'skipped' || compare(at, lower) <= 0 || compare(at, upper) > 0)
                continue;
              rows.push({
                position: at,
                facts: admissionNoticeFactsSchema.parse({
                  requestId: request.id,
                  receiptId: receipt.id,
                  bindingId: binding.bindingId,
                  resource: request.resource,
                  overlap: request.overlap,
                  blocker: request.blocker,
                  deliveryId: receipt.deliveryId,
                  receivedAt: receipt.receivedAt,
                  sourceActor: receipt.sourceActor,
                  codebaseId: request.launch.run.codebase_id,
                  cwd: request.launch.execution.cwd,
                }),
              });
            }
          }
        }
        rows.sort((a, b) => compare(a.position, b.position));
        const caughtUp = rows.length <= limit;
        const notices = rows
          .slice(0, limit)
          .map(row => ({ cursor: cursor(row.position), facts: row.facts }));
        return {
          notices,
          next: caughtUp ? cursor(upper) : notices[notices.length - 1].cursor,
          caughtUp,
        };
      });
    },
  };
}
