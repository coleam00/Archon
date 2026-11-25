import type { StartReceiptInspection } from '@archon/workflows/resource-start-store';
import {
  ASKS_SETTLED_SOURCE_ACTOR,
  RUN_ENDED_SOURCE_ACTOR,
  type ResourceStartBindingIntent,
} from '@archon/workflows/schemas/resource-start';
import { rebuildAsksSettledStart } from './asks-settled';
import {
  rebuildRunEndedStart,
  startFileKey,
  startRevision,
  type RebuildReads,
  type RebuiltStart,
  type StartFiles,
} from './run-ended';

export type WaitingStartFate = { keep: true } | { unknown: Error } | RebuiltStart;

/**
 * What becomes of a waiting start a run's end or settled asks caused: it follows its
 * trigger file, the file with its `sourceInstanceId` and host in this home's trigger
 * directory. One comparison decides it: the file's revision (`startRevision`) against the
 * start's recorded one. Equal: keep the start as it is. Different, or none recorded:
 * rebuild it from the file, or refuse it. A home whose readable files name no file on the
 * start's host is not its registry, so the start is kept; with no match and a file that
 * does not read, which may be the start's own, the answer is unknown. Other starts keep
 * the binding their receipt froze.
 */
export async function waitingStart(
  start: {
    receipt: Pick<StartReceiptInspection, 'sourceActor' | 'sourceInstanceId' | 'itemKey'>;
    bindingRevision: string | null;
    intent: ResourceStartBindingIntent;
  },
  files: StartFiles,
  reads: RebuildReads
): Promise<WaitingStartFate> {
  const { receipt, intent } = start;
  const source = receipt.sourceActor?.source;
  if (source !== RUN_ENDED_SOURCE_ACTOR && source !== ASKS_SETTLED_SOURCE_ACTOR)
    return { keep: true };
  const key = startFileKey(receipt.sourceInstanceId, intent.hostId);
  if (!files.byStart.has(key)) {
    if (!files.hosts.has(intent.hostId)) return { keep: true };
    const [unread] = files.unread;
    if (unread) return { unknown: unread };
  }
  const file = files.byStart.get(key);
  if (
    !file ||
    'runEnded' in file !== (source === RUN_ENDED_SOURCE_ACTOR) ||
    file.binding.bindingId !== intent.bindingId
  )
    return {
      refused: {
        reason: 'launch_preparation_failed',
        detail: `the trigger file of '${receipt.sourceInstanceId}' on host '${intent.hostId}' is gone or binds another start`,
      },
    };
  if (startRevision(file) === start.bindingRevision) return { keep: true };
  return 'runEnded' in file
    ? rebuildRunEndedStart(file, receipt, intent, reads)
    : rebuildAsksSettledStart(file, receipt, intent, reads);
}
