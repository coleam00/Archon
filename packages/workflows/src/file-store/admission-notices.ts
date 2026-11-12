import { join } from 'node:path';
import {
  admissionNoticeCursor,
  admissionNoticeFactsSchema,
  validateAdmissionNoticeLimit,
  type AdmissionNoticeCursor,
  type AdmissionNoticeFacts,
} from '../admission-notice';
import type { IResourceStartStore } from '../resource-start-store';
import { WorkflowEventCursorError } from '../store';
import { receiptSchema, requestSchema, pathFor } from './admission-documents';
import {
  admissionPositionSchema,
  compareAdmissionPositions as compare,
  ensureAdmissionNoticeIndex,
  admissionEntriesAt,
  admissionEntriesSince,
  type AdmissionPosition as Position,
  type AdmissionIndexEntry,
} from './admission-notice-index';
import { readJson, readFileStoreHead, recoverFileStoreLocked, recoverBeforeRead } from './commit';
import { withFileStoreLock } from './lock';

const cursor = (position: Position): AdmissionNoticeCursor =>
  admissionNoticeCursor(`file-admission:${JSON.stringify(position)}`);

function position(after: AdmissionNoticeCursor | null): Position {
  if (after === null) return [0, null];
  try {
    if (!after.startsWith('file-admission:')) throw new WorkflowEventCursorError();
    return admissionPositionSchema.parse(JSON.parse(after.slice('file-admission:'.length)));
  } catch {
    throw new WorkflowEventCursorError();
  }
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
    readAdmissionNoticesAfter: async (after, { limit, since }) => {
      validateAdmissionNoticeLimit(limit);
      const lower = position(after);
      await recoverBeforeRead(root);
      const head: Position = [await readFileStoreHead(root), null];
      if (compare(lower, head) > 0) throw new WorkflowEventCursorError();
      if (compare(lower, head) === 0) return { notices: [], next: cursor(head), caughtUp: true };
      return withFileStoreLock(root, async () => {
        await recoverFileStoreLocked(root);
        const upper: Position = [await readFileStoreHead(root), null];
        await ensureAdmissionNoticeIndex(root, upper[0]);
        let entries: AdmissionIndexEntry[] = [];
        let scanned: Position = upper;
        if (since !== undefined) {
          entries = await admissionEntriesSince(root, since, lower, upper, limit + 1);
        } else {
          // Empty commits count toward the scan budget, so a watch never holds the
          // writer lock for an unbounded backlog of unrelated workflow activity.
          const start = lower[1] === null ? lower[0] + 1 : lower[0];
          const end = Math.min(upper[0], start + Math.max(100, limit) - 1);
          for (let seq = start; seq <= end; seq++) {
            entries.push(
              ...(await admissionEntriesAt(root, seq)).filter(
                row => compare(row.position, lower) > 0
              )
            );
            scanned = [seq, null];
            if (entries.length > limit) break;
          }
        }
        const notices: { cursor: AdmissionNoticeCursor; facts: AdmissionNoticeFacts }[] = [];
        for (const entry of entries.slice(0, limit)) {
          const receipt = receiptSchema.parse(
            await readJson(join(root, pathFor('receipts', entry.receiptId)))
          );
          const request = requestSchema.parse(
            await readJson(join(root, pathFor('requests', entry.position[1])))
          );
          notices.push({
            cursor: cursor(entry.position),
            facts: admissionNoticeFactsSchema.parse({
              requestId: request.id,
              receiptId: receipt.id,
              bindingId: entry.bindingId,
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
        const next = entries.length > limit ? notices[notices.length - 1].cursor : cursor(scanned);
        return { notices, next, caughtUp: next === cursor(upper) };
      });
    },
  };
}
