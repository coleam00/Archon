/**
 * Act on a person's answer to the merge queue's attention item.
 *
 * The answer is one of the declared choices, so its effect is read from the choice,
 * never from the answer's text. On a pull request: `merge` records the approval pinned
 * to the head that was asked about, and the next sweep merges it once the gate passes
 * at that head; `return` hands the item back to the build queue with the brief the
 * sweep wrote; `park` stops working it until renewed build readiness or, for an
 * answered own-PR park, a different head observed by a later sweep. A
 * choice's ruling and the person's words are written into the issue body as one dated
 * "Current scope" section first, as the build queue does, so a returned round reads
 * them as the contract; an enrolled own pull request has no issue body, so its ruling
 * stays on its work item. On a red default branch the only answer is `hold`: the queue
 * merges nothing while the branch is red, which every sweep reads from the forge, so
 * nothing is written. A `merge` then starts a sweep at once, on the run config and input
 * selections this run started with, and a `return` the item's next build-queue round, on
 * this run's config and the build queue's own input defaults; if that launch fails, the
 * next queue run picks the item up as before.
 *
 * Bound inputs: INPUTS_ASKED, what record asked; INPUTS_CHOICE and INPUTS_TEXT, the
 * attention answer; INPUTS_LIMIT, INPUTS_MERGE_METHOD and INPUTS_RETRIAGE_AS, the workflow's inputs.
 */

import { withBuild } from '../../.shared/build.ts';
import type { QualifiedPr } from '../../.shared/forge.ts';
import { emit, note, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { launchDetached, type MergeQueueSelections } from '../../.shared/launch.ts';
import { appendSection } from '../../.shared/issue.ts';
import { answeredMergeDecision, type MergeAsked, type MergeAttention, type MergeDecisionEntry, type MergeStatus, withMerge } from '../../.shared/merge.ts';
import { chosen, rulingHeading } from '../../.shared/queue.ts';
import { updateClaimed } from '../../.shared/workitem.ts';

const STATUS = { merge: 'waiting', return: 'returned', park: 'parked' } as const satisfies Record<
  MergeAttention['choices'][number]['effect'],
  MergeStatus
>;

/** Act on the answer now; on failure the released item waits for the next queue run. */
function continueNow(effect: string, item: QualifiedPr, runId: string, selections: MergeQueueSelections): string {
  if (effect !== 'merge' && effect !== 'return') return '';
  const repo = { repo_host: item.repo.host, repo_path: item.repo.path };
  try {
    const next =
      effect === 'merge'
        ? launchDetached('archon-merge-queue', { ...selections, ...repo }, { configFromRun: runId })
        : // The build queue declares none of the merge queue's selections, so a returned
          // round runs on the build queue's defaults.
          launchDetached('archon-build-queue', { ...repo, number: String(item.number) }, { configFromRun: runId });
    return `; run ${next} acts on it now`;
  } catch (error) {
    note(`issue ${String(item.number)}: the follow-up run did not start, so the next queue run picks it up: ${error instanceof Error ? error.message : String(error)}`);
    return '; the next queue run picks it up';
  }
}

/**
 * Write the ruling into the issue body as a dated section; returns its heading, or ''.
 * An enrolled own pull request is its own work item and has no issue body to write, so
 * its ruling stays on the work item's decision entry, which keeps the answer's text.
 */
function writeRuling(asked: Extract<MergeAsked, { by: 'pr' }>, ruling: string, at: string): string {
  // Issues and pull requests share one numbering, so an item numbered as its pull request is that pull request.
  const ownPr = asked.item.number === asked.pr.number && asked.item.repo.path === asked.pr.repo.path && asked.item.repo.host === asked.pr.repo.host;
  if (ruling === '' || ownPr) return '';
  const heading = rulingHeading(at, `the merge queue's question on PR ${String(asked.pr.number)}`);
  appendSection(asked.item, heading, ruling);
  return heading;
}

function main(): void {
  const asked = nullableJson(process.env.INPUTS_ASKED) as MergeAsked | null;
  if (asked === null) throw new Error('the answer arrived with nothing asked');
  const id = trimmed(process.env.INPUTS_CHOICE);
  const words = trimmed(process.env.INPUTS_TEXT);
  if (asked.by === 'base') {
    chosen(asked.attention, id);
    emit({
      decision: 'hold',
      section: '',
      summary: 'The queue holds merges while the default branch is red; every sweep reads that from the forge.',
    });
    return;
  }

  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  const choice = chosen(asked.attention, id);
  const at = new Date().toISOString();
  const selections: MergeQueueSelections = {
    limit: text(process.env.INPUTS_LIMIT),
    merge_method: text(process.env.INPUTS_MERGE_METHOD),
    retriage_as: text(process.env.INPUTS_RETRIAGE_AS),
  };
  const ruling = [choice.ruling.trim(), words === '' ? '' : `The maintainer's words: ${words}`]
    .filter(part => part !== '')
    .join('\n\n');
  const heading = writeRuling(asked, ruling, at);

  const entry: MergeDecisionEntry = {
    at,
    run_id: runId,
    decision: answeredMergeDecision(choice.effect),
    reason: choice.label,
    links: asked.attention.links,
    answer: { choice: choice.id, text: words, at },
    head: asked.head,
    reran: false,
  };
  updateClaimed(asked.item, runId, doc => {
    const recorded = withMerge(doc, {
      at,
      run_id: runId,
      entry,
      status: STATUS[choice.effect],
      pr: asked.pr,
      ...(choice.effect === 'merge' ? { approval: { head: asked.head, at } } : {}),
      release: true,
    });
    if (choice.effect !== 'return') return recorded;
    const brief = `${asked.brief}\n\nThe maintainer chose "${choice.label}": ${choice.does}${heading === '' ? '' : ` The ruling is the issue body's "${heading}" section, which is part of the contract.`}`;
    return withBuild(recorded, { at, run_id: runId, round: null, entry, status: 'next', brief, release: true });
  });
  emit({
    decision: choice.effect,
    section: heading,
    summary: `PR ${String(asked.pr.number)}: the maintainer chose ${choice.id} (${choice.effect})${continueNow(choice.effect, asked.item, runId, selections)}.`,
  });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue ruling: ${error instanceof Error ? error.message : String(error)}`);
}
