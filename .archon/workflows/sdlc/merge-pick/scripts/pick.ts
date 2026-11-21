/**
 * The merge stage's backstop: start a merge run on every item it has that no event starts.
 *
 * A merge run starts when a build ends ready, when a check completes at a commit its
 * item waits on, and when its ask is answered. What a pull request waits for besides
 * that has no forge event the pack binds: a review thread resolved, a draft marked ready,
 * the forge computing whether it merges, a new review verdict comment, a validation
 * recorded under `ci: none`, a default branch fixed by a new commit, and a start or an
 * event that was lost. This pass reads none of them: it starts a run on each such item,
 * and that run reads them.
 *
 * It starts every item the merge stage has (`mergeWaits`) except one whose ask is open,
 * which an answer starts, one the engine shows waiting for a check that is not overdue,
 * which the check starts, one with a merge run already queued or running, and one whose
 * newest merge run failed, which the operator resumes or abandons. Each start is a fire of the operator's merge-queue
 * binding on the issue's item, so it runs under that binding's resource, one merge run
 * at a time. The delivery id names this run, so a retried node fires no start twice.
 *
 * Bound inputs: the workflow's INPUTS_MERGE_QUEUE_BINDING.
 */

import { emit, input, items, refuse, runId as workflowRunId, state, trigger } from 'archon:script';
import { sameRepo } from '../../.shared/identity.ts';
import { mergeWaits } from '../../.shared/merge.ts';
import { workflowRepo } from '../../.shared/remote.ts';
import { itemKey, PICKUP_ORDER, read, sortCandidates } from '../../.shared/workitem.ts';

const STAGE = 'archon-merge-queue';

/**
 * The items this pass must not start: one something already starts a merge run on (an
 * open wait of the stage before its deadline, which a check meets, a start of the stage
 * still queued, or a run of it not yet ended), and one whose newest merge run failed.
 *
 * It pages every item with a run in the window on every pass, on purpose. The stage's
 * binding is `overlap: queue`, so nothing refuses a second start of an item, and a
 * `skip` binding could not stand in: admission sees neither an open wait nor a start
 * queued behind another item. Without this check each pass would start duplicates.
 *
 * A failed run is not started again, such as one whose pull request cannot be read. It
 * stays in `archon workflow runs --open`, and resuming or abandoning it is the
 * operator's action; a run that then completes or is cancelled frees the item.
 */
function alreadyHeld(): Set<string> {
  const keys = new Set<string>();
  let page = items({ limit: 100 });
  for (;;) {
    for (const entry of page.items) {
      const waits = entry.waits.some(wait => wait.workflow === STAGE && !wait.overdue);
      const queued = entry.queued.some(start => start.workflow === STAGE);
      // Runs are listed in the order they started.
      const newest = entry.runs.filter(run => run.workflow === STAGE).at(-1)?.status;
      if (waits || queued || newest === 'pending' || newest === 'running' || newest === 'failed') keys.add(entry.item.key);
    }
    if (page.next === null) return keys;
    page = items({ after: page.next, limit: 100 });
  }
}

function main(): void {
  const binding = input('merge_queue_binding').trim();
  if (binding === '') throw new Error('merge_queue_binding is empty; the backstop starts merge runs only through that binding');
  const repo = workflowRepo();
  const runId = workflowRunId();
  const held = alreadyHeld();
  const waiting = state.listValues('work/')
    .map(stored => read(stored.name, stored))
    .filter(item => item !== undefined)
    .filter(({ doc }) => sameRepo(doc.subject.repo, repo) && mergeWaits(doc) && doc.facts.merge?.status !== 'asking')
    .filter(({ doc }) => !held.has(itemKey(doc.subject.number)));
  const started: number[] = [];
  const lines: string[] = [];
  for (const { doc } of sortCandidates(waiting, PICKUP_ORDER)) {
    const { number } = doc.subject;
    try {
      const fired = trigger.fire(binding, {}, { deliveryId: `merge-pick:${repo.host}/${repo.path}#${String(number)}:${runId}`, item: itemKey(number) });
      started.push(number);
      lines.push(`issue ${String(number)}: ${fired.disposition?.status ?? 'not admitted'}`);
    } catch (error) {
      lines.push(`issue ${String(number)}: not started, the next pass starts it (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  emit({ started, summary: lines.length === 0 ? 'No item waits for a merge run that no event starts.' : lines.join('\n') });
}

try {
  main();
} catch (error) {
  refuse(`merge-pick: ${error instanceof Error ? error.message : String(error)}`);
}
