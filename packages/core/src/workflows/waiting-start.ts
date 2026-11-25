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
  type OnBinding,
  type RebuildReads,
  type RebuiltStart,
  type StartFiles,
} from './run-ended';

/** A waiting start's receipt, and its binding as recorded. */
export interface WaitingStart {
  receipt: Pick<StartReceiptInspection, 'sourceActor' | 'sourceInstanceId' | 'itemKey'>;
  bindingRevision: string | null;
  intent: ResourceStartBindingIntent;
}

export type StartFile =
  /** Run it as it is. */
  | { keep: true }
  /** Its own file does not read, or two files register it: it waits for the operator. */
  | { unknown: Error }
  /** Its file can no longer start it. */
  | { refused: Extract<RebuiltStart, { refused: unknown }>['refused'] }
  /** Its file changed, or it recorded no revision of it: rebuild it from this file. */
  | { changed: OnBinding };

/**
 * Whether a waiting start a run's end or settled asks caused still matches its trigger
 * file: the file registering its `sourceInstanceId` on its host. One comparison decides it,
 * the file's revision (`startRevision`, over `binding` and `on`) against the start's
 * recorded one; a revision recorded before it covered `on`, or none, differs, so such a
 * start is rebuilt once. A file of another source never affects the answer. A start with no
 * file is kept as it is, and other sources' starts keep the binding their receipt froze.
 */
export function startFile(start: WaitingStart, files: StartFiles): StartFile {
  const { receipt, intent } = start;
  const source = receipt.sourceActor?.source;
  if (source !== RUN_ENDED_SOURCE_ACTOR && source !== ASKS_SETTLED_SOURCE_ACTOR)
    return { keep: true };
  const entries = files.byStart.get(startFileKey(receipt.sourceInstanceId, intent.hostId)) ?? [];
  const [entry] = entries;
  if (!entry) return { keep: true };
  if (entries.length > 1)
    return {
      unknown: new Error(
        `${String(entries.length)} trigger files register '${receipt.sourceInstanceId}' on host '${intent.hostId}'`
      ),
    };
  if ('unreadable' in entry) return { unknown: entry.unreadable };
  const file = entry.binding;
  if (
    !file ||
    'runEnded' in file !== (source === RUN_ENDED_SOURCE_ACTOR) ||
    file.binding.bindingId !== intent.bindingId
  )
    return {
      refused: {
        reason: 'launch_preparation_failed',
        detail: `the trigger file of '${receipt.sourceInstanceId}' now binds another start`,
      },
    };
  return startRevision(file) === start.bindingRevision ? { keep: true } : { changed: file };
}

/** A waiting start as its changed file builds it now, through the matcher's own pieces. */
export function rebuildStart(
  file: OnBinding,
  start: WaitingStart,
  reads: RebuildReads
): Promise<RebuiltStart> {
  return 'runEnded' in file
    ? rebuildRunEndedStart(file, start.receipt, start.intent, reads)
    : rebuildAsksSettledStart(file, start.receipt, start.intent, reads);
}
