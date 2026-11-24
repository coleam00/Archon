/**
 * Whether an item's place waits on the change host. The server answers merged for an item
 * whose merge the engine recorded without asking the host; otherwise it answers a change's
 * merge state `pending` while its first lookup still runs (`GET /api/factory/progress`), and
 * the console re-reads until it settles. A pending or `unknown` item is placed by its runs
 * (it never moves back from the landed column, `itemColumn`), and the board's columns show a
 * pending one as loading. The Overview's numbers count only items whose state is known
 * (`mergeUnsettled`): a skeleton stands beside them while one is pending (Visual standard
 * rule 6: a skeleton means loading), and a line says how many could not be read while one is
 * `unknown` (`mergeUnknown`), which may never settle. An item whose progress could
 * not be read and one with no change are counted where placement puts them. A settled
 * `false` or `unknown` is still asked about again on an interval (`awaitingMerge`).
 */
import type { FactoryItem } from '../../skills/factory';

/** A change's merge state as the items read carries it. */
export type ChangeMerged = NonNullable<NonNullable<FactoryItem['progress']>['change']>['merged'];

/**
 * Whether the item's place waits on its merge state. A running item is placed by its run
 * (rule 1) whatever the change host says, so it does not wait.
 */
export function mergePending(item: FactoryItem): boolean {
  const progress = item.progress;
  return progress?.change?.merged === 'pending' && progress.running == null;
}

/**
 * Whether the item's merge state is not known: `pending`, or `unknown` after a failed
 * lookup, with no run working it. The counts that say what merged and what is in flight
 * leave such an item out, as either might be wrong.
 */
export function mergeUnsettled(item: FactoryItem): boolean {
  const progress = item.progress;
  const merged = progress?.change?.merged;
  return (merged === 'pending' || merged === 'unknown') && progress?.running == null;
}

/**
 * Whether the item's merge state could not be read: `unknown` (the lookup failed, or found no
 * pull request) with no run working it. Unlike `pending` it may never settle, so the Overview
 * says it in words rather than as loading.
 */
export function mergeUnknown(item: FactoryItem): boolean {
  return item.progress?.change?.merged === 'unknown' && item.progress.running == null;
}

export function anyMergePending(items: readonly FactoryItem[]): boolean {
  return items.some(mergePending);
}

/**
 * Whether the item has a change the forge has not reported merged: `false`, or `unknown`
 * after a failed lookup that may recover. A merge on the forge is no run event, so the page
 * asks again on an interval while one is left (`merge-watch.ts`). `pending` is not here: the
 * short re-read owns that state until the server answers (`merge-reread.ts`).
 */
export function awaitingMerge(item: FactoryItem): boolean {
  const merged = item.progress?.change?.merged;
  return merged === false || merged === 'unknown';
}

/** The keys of the items that `awaitingMerge`. */
export function awaitingMergeKeys(items: readonly FactoryItem[]): string[] {
  return items.filter(awaitingMerge).map(item => item.item.key);
}

/**
 * Whether a stage's count waits on a merge answer: it holds an item that waits, or it is the
 * landed stage and any item waits (the answer may move it there). The board's columns and
 * the map's cards both ask here, so they agree.
 */
export function stageCountPending(
  stage: string,
  landedStage: string,
  held: readonly FactoryItem[],
  anyPending: boolean
): boolean {
  return (stage === landedStage && anyPending) || held.some(mergePending);
}
