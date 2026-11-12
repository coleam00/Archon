/**
 * Act on a person's answer to the merge queue's attention item.
 *
 * The answer names one of the options the ask declared, so its effect is read from that
 * option's value, never from the answer's text.
 * An `other` answer names none: its text is the ruling, and the item returns to
 * the build queue when the sweep wrote a brief and parks otherwise. On a pull request: `merge` records the approval pinned
 * to the head that was asked about, and the next sweep merges it once the gate passes
 * at that head; `return` hands the item back to the build queue with the brief the
 * sweep wrote; `park` stops working it until renewed build readiness. A
 * choice's ruling and the person's words are written into the issue body as one dated
 * "Current scope" section first, as the build queue does, so a returned round reads
 * them as the contract. A `merge` then starts a sweep at once through the operator's
 * merge-queue binding, and a `return` the item's next round through the build-queue
 * binding; if it does not start, the next queue run picks the item up as before.
 *
 * Bound inputs: INPUTS_ASKED, what record asked; INPUTS_DECISION, the id of the chosen
 * option (`other` for the wait's own), and INPUTS_TEXT, the answer's text; INPUTS_MERGE_QUEUE_BINDING and
 * INPUTS_BUILD_QUEUE_BINDING, the workflow's inputs.
 */

import { nextRound, withBuild } from '../../.shared/build.ts';
import { followUp } from '../../.shared/follow-up.ts';
import { emit, input, refuse, runId as workflowRunId } from 'archon:script';
import { type QualifiedPr } from '../../.shared/identity.ts';
import { nullableJson } from '../../.shared/inputs.ts';
import { appendSection } from '../../.shared/issue.ts';
import { answeredMergeDecision, type MergeAsked, type MergeDecisionEntry, type MergeEffect, type MergeStatus, otherEffect, withMerge } from '../../.shared/merge.ts';
import { answeredChoice, rulingHeading } from '../../.shared/queue.ts';
import { updateClaimed } from '../../.shared/workitem.ts';

const STATUS = { merge: 'waiting', return: 'returned', park: 'parked' } as const satisfies Record<MergeEffect, MergeStatus>;

/** Act on the answer now; when that does not start, the released item waits for the next queue run. */
function continueNow(effect: string, item: QualifiedPr, runId: string): string {
  if (effect === 'return') return `; ${nextRound(item, runId)}`;
  if (effect !== 'merge') return '';
  const { host, path } = item.repo;
  // A sweep merges whatever waits; the binding names the repository, so it takes no inputs.
  const key = `merge-sweep:${host}/${path}#${String(item.number)}:${runId}`;
  return `; ${followUp(input('merge_queue_binding'), key, {}, 'a sweep')}`;
}

/** Write the ruling into the issue body as a dated section; returns its heading, or ''. */
function writeRuling(asked: MergeAsked, ruling: string, at: string): string {
  if (ruling === '') return '';
  const heading = rulingHeading(at, `the merge queue's question on PR ${String(asked.pr.number)}`);
  appendSection(asked.item, heading, ruling);
  return heading;
}

function main(): void {
  const asked = nullableJson(input('asked')) as MergeAsked | null;
  if (asked === null) throw new Error('the answer arrived with nothing asked');
  const words = input('text').trim();
  const runId = workflowRunId();
  const choice = answeredChoice(asked.ask, input('decision').trim(), otherEffect(asked.brief));
  const { effect } = choice.value;
  const at = new Date().toISOString();
  const ruling = [choice.value.ruling.trim(), words === '' ? '' : `The maintainer's words: ${words}`]
    .filter(part => part !== '')
    .join('\n\n');
  const heading = writeRuling(asked, ruling, at);

  const entry: MergeDecisionEntry = {
    at,
    run_id: runId,
    decision: answeredMergeDecision(effect),
    reason: choice.label,
    links: [],
    answer: { choice: choice.id, text: words, at },
    head: asked.head,
    reran: false,
  };
  updateClaimed(asked.item, runId, doc => {
    const recorded = withMerge(doc, {
      at,
      run_id: runId,
      entry,
      status: STATUS[effect],
      pr: asked.pr,
      ...(effect === 'merge' ? { approval: { head: asked.head, at } } : {}),
      release: true,
    });
    if (effect !== 'return') return recorded;
    const brief = `${asked.brief}\n\nThe maintainer chose "${choice.label}": ${choice.does}${heading === '' ? '' : ` The ruling is the issue body's "${heading}" section, which is part of the contract.`}`;
    return withBuild(recorded, { at, run_id: runId, round: null, entry, status: 'next', brief, release: true });
  });
  emit({
    decision: effect,
    section: heading,
    summary: `PR ${String(asked.pr.number)}: the maintainer chose ${choice.id} (${effect})${continueNow(effect, asked.item, runId)}.`,
  });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue ruling: ${error instanceof Error ? error.message : String(error)}`);
}
