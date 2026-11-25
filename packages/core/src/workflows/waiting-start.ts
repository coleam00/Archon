import { isDeepStrictEqual } from 'node:util';
import { createLogger } from '@archon/paths';
import type { StartReceiptInspection } from '@archon/workflows/resource-start-store';
import {
  ASKS_SETTLED_SOURCE_ACTOR,
  RUN_ENDED_SOURCE_ACTOR,
  type ResourceStartBindingIntent,
} from '@archon/workflows/schemas/resource-start';
import { rebuildAsksSettledStart } from './asks-settled';
import {
  rebuildRunEndedStart,
  refusedRebuild,
  startRevision,
  type RebuildReads,
  type RebuiltStart,
  type triggerRegistry,
} from './run-ended';

const log = createLogger('resource-start-host');

export type WaitingStart = { keep: true } | { wait: Error } | RebuiltStart;

/**
 * What becomes of a waiting start, pending or queued, before it is prepared or admitted.
 *
 * A waiting start that a run's end or settled asks caused follows its trigger file. Its
 * registration is the file with its `sourceInstanceId` and `binding.hostId`, in the
 * trigger directory of the home that serves that host (`triggerRegistry`).
 * - The file's revision (`startRevision`) equals the start's recorded revision: keep the
 *   start exactly as it is.
 * - Otherwise rebuild it from the file and its recorded cause, with the matcher's own
 *   pieces. A rebuilt intent equal to the stored one, revision aside, keeps the start as it
 *   is; a different one replaces it. A receipt the shipped binary wrote hashed the binding
 *   alone, so it differs once and is kept by this rule when nothing else changed.
 * - The file is absent, no longer binds this cause, or its inputs do not map: refuse the
 *   start on its item. A start with no recorded revision keeps its launch instead.
 * - The start's own file does not read, or no readable file is the start's while one whose
 *   identity cannot be read exists: wait.
 * - The home does not serve the start's host: keep. Another home's registry is not judged.
 */
export async function resolveWaitingStart(
  registry: ReturnType<typeof triggerRegistry>,
  read: RebuildReads,
  start: {
    receipt: Pick<StartReceiptInspection, 'sourceActor' | 'sourceInstanceId' | 'itemKey'>;
    bindingRevision: string | null;
    intent: ResourceStartBindingIntent;
  }
): Promise<WaitingStart> {
  const { receipt, bindingRevision, intent } = start;
  const actor = receipt.sourceActor;
  if (actor?.source !== RUN_ENDED_SOURCE_ACTOR && actor?.source !== ASKS_SETTLED_SOURCE_ACTOR)
    return { keep: true };
  if (!(await registry.serves(intent.hostId))) return { keep: true };
  const registration = await registry.find({
    sourceInstanceId: receipt.sourceInstanceId,
    hostId: intent.hostId,
  });
  if ('unreadable' in registration) return { wait: registration.unreadable };
  const file = 'found' in registration ? registration.found : undefined;
  if (file && startRevision(file) === bindingRevision) return { keep: true };
  const cause = { runId: actor.id, outcome: actor.display ?? '', itemKey: receipt.itemKey };
  const rebuilt = !file
    ? refusedRebuild(
        `trigger file for '${receipt.sourceInstanceId}' on host '${intent.hostId}' is gone`
      )
    : 'runEnded' in file !== (actor.source === RUN_ENDED_SOURCE_ACTOR)
      ? refusedRebuild(`${file.file} no longer binds the event that caused this start`)
      : file.binding.bindingId !== intent.bindingId
        ? refusedRebuild(`${file.file} now names binding '${file.binding.bindingId}'`)
        : 'runEnded' in file
          ? await rebuildRunEndedStart(file, cause, intent, read)
          : await rebuildAsksSettledStart(file, cause, intent, read);
  if ('intent' in rebuilt) return sameStart(rebuilt.intent, intent) ? { keep: true } : rebuilt;
  if (bindingRevision !== null) return rebuilt;
  log.info(
    { sourceInstanceId: receipt.sourceInstanceId, detail: rebuilt.refused.detail },
    'resource_start.unrevised_start_kept'
  );
  return { keep: true };
}

/** Whether two intents start the same thing, whatever revision each records; key order aside. */
function sameStart(a: ResourceStartBindingIntent, b: ResourceStartBindingIntent): boolean {
  const plain = ({ bindingRevision: _revision, ...intent }: ResourceStartBindingIntent) =>
    JSON.parse(JSON.stringify(intent)) as unknown;
  return isDeepStrictEqual(plain(a), plain(b));
}
