import {
  getFactoryProgress,
  type FactoryItemDetail,
  type FactoryProgress,
} from '../skills/factory';
import { get, patch } from '../store/cache';
import { K } from '../store/keys';
import { FACTORY_READ_DEADLINE_MS, withDeadline } from './lib/deadline';
import { PAGE_LIMIT, withProgress, type FactoryItemsRead } from './lib/factory-items-read';
import { awaitingMergeKeys } from './lib/merge-pending';

/**
 * How often the page asks again about changes the forge has not reported merged. A merge on
 * the forge is no run event, so nothing else asks once an item's last run ended. The server
 * keeps a not-merged answer for 60 s, then serves it once more while it refreshes, so a
 * merge shows on the ask after the one that started the refresh: typically 60 to 90 s after
 * it, at worst about 2 min. A shorter interval would mostly re-read the server's cached answer.
 */
export const MERGE_WATCH_MS = 30_000;

export interface MergeWatchDeps {
  getProgress: typeof getFactoryProgress;
  delayMs: number;
  /** The page's document, for its visibility; `globalThis.document` when absent. */
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

const DEFAULT_DEPS: MergeWatchDeps = { getProgress: getFactoryProgress, delayMs: MERGE_WATCH_MS };

interface Watch {
  readers: number;
  deps: MergeWatchDeps;
  timer?: ReturnType<typeof setTimeout>;
  /** Removes the listener a hidden tab waits on. */
  stopWaiting?: () => void;
}

/** One watch per project, however many readers: every Factory page reads the same items. */
const watches = new Map<string, Watch>();

/**
 * Watches the merge state of `K.factoryItems(projectId)` while the caller holds it: every
 * `deps.delayMs` it asks `GET /api/factory/progress` about the items whose change is not
 * merged (`awaitingMerge`), only those keys, and patches the answers into the items, so the
 * board, the Merged column and the Overview's numbers place them from the same value. It
 * asks nothing while the tab is hidden and asks at once when it shows again. Returns the
 * release; the last release stops the watch. The first watcher's `deps` hold for the watch.
 */
export function watchMerges(projectId: string, deps: MergeWatchDeps = DEFAULT_DEPS): () => void {
  let watch = watches.get(projectId);
  if (watch === undefined) {
    watch = { readers: 0, deps };
    watches.set(projectId, watch);
    schedule(projectId, watch);
  }
  const held = watch;
  held.readers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.readers--;
    if (held.readers === 0) stop(projectId, held);
  };
}

/** Whether a watch on `projectId` is held; for tests of the readers that hold it. */
export function mergeWatchHeld(projectId: string): boolean {
  return watches.has(projectId);
}

/** Stops every watch; for tests, so a timer never fires into the next one. */
export function cancelMergeWatches(): void {
  for (const [projectId, watch] of watches) stop(projectId, watch);
}

function live(projectId: string, watch: Watch): boolean {
  return watches.get(projectId) === watch;
}

function stop(projectId: string, watch: Watch): void {
  clearTimeout(watch.timer);
  watch.stopWaiting?.();
  if (live(projectId, watch)) watches.delete(projectId);
}

function schedule(projectId: string, watch: Watch): void {
  watch.timer = setTimeout(() => void tick(projectId, watch), watch.deps.delayMs);
}

/**
 * One ask, then the next one scheduled while the watch lives, an ask with nothing waiting
 * included: the readers' release is what stops it, so a value that stops and starts waiting
 * between two renders never strands the watch.
 */
async function tick(projectId: string, watch: Watch): Promise<void> {
  watch.timer = undefined;
  if (!live(projectId, watch)) return;
  const doc = watch.deps.doc ?? globalThis.document;
  if (doc?.visibilityState === 'hidden') {
    waitUntilVisible(projectId, watch, doc);
    return;
  }
  try {
    await readWaiting(projectId, watch);
  } catch (err) {
    // The board keeps its last read and the next tick asks again; a failed ask changes
    // nothing a person sees, so it is only logged.
    console.warn('[console-factory] merge watch read failed', { projectId, err });
  } finally {
    if (live(projectId, watch)) schedule(projectId, watch);
  }
}

/** Waits for the tab to show, then asks at once: the merge was likely made in another tab. */
function waitUntilVisible(
  projectId: string,
  watch: Watch,
  doc: NonNullable<MergeWatchDeps['doc']>
): void {
  const onChange = (): void => {
    if (doc.visibilityState === 'hidden') return;
    watch.stopWaiting?.();
    void tick(projectId, watch);
  };
  doc.addEventListener('visibilitychange', onChange);
  watch.stopWaiting = () => {
    doc.removeEventListener('visibilitychange', onChange);
    watch.stopWaiting = undefined;
  };
}

/**
 * Asks about the waiting keys, a page of them per request, and patches every answer in at
 * once: into the items every Factory page reads, and into each waiting item's own read that
 * is cached (the item page's header), so the two never disagree on a merge. A read that
 * landed meanwhile is newer than this ask, so the answer is dropped for that value.
 */
async function readWaiting(projectId: string, watch: Watch): Promise<void> {
  const key = K.factoryItems(projectId);
  const before = get(key) as FactoryItemsRead | undefined;
  if (before === undefined) return;
  const keys = awaitingMergeKeys(before.items);
  const details = keys.map(itemKey => {
    const detailKey = K.factoryItem(projectId, itemKey);
    return { itemKey, detailKey, detail: get(detailKey) as FactoryItemDetail | undefined };
  });
  const answers: FactoryProgress[] = [];
  for (let start = 0; start < keys.length; start += PAGE_LIMIT) {
    const page = keys.slice(start, start + PAGE_LIMIT);
    answers.push(
      await withDeadline(FACTORY_READ_DEADLINE_MS, signal =>
        watch.deps.getProgress({ codebaseId: projectId, keys: page }, { signal })
      )
    );
  }
  if (answers.length === 0 || !live(projectId, watch)) return;
  if (get(key) === before) patch(key, () => answers.reduce(withProgress, before));
  patchDetails(details, answers);
}

/** Each cached item read, as it was before the ask, takes the progress the answers give it. */
function patchDetails(
  details: { itemKey: string; detailKey: string; detail: FactoryItemDetail | undefined }[],
  answers: readonly FactoryProgress[]
): void {
  for (const { itemKey, detailKey, detail } of details) {
    const answer = answers.find(page => Object.hasOwn(page.progress, itemKey));
    if (detail === undefined || answer === undefined || get(detailKey) !== detail) continue;
    const progress = answer.progress[itemKey] ?? null;
    patch(detailKey, () => ({ ...detail, item: { ...detail.item, progress } }));
  }
}
