/**
 * Act on a person's answer to the merge queue's attention item.
 *
 * The answer is one of the declared choices, so its effect is read from the choice,
 * never from the answer's text. On a pull request: `merge` records the approval pinned
 * to the head that was asked about, and the next sweep merges it once the gate passes
 * at that head; `return` hands the item back to the build queue with the brief the
 * sweep wrote; `park` stops working it until the build queue readies it again. A
 * choice's ruling and the person's words are written into the issue body as one dated
 * "Current scope" section first, as the build queue does, so a returned round reads
 * them as the contract. On a red default branch the only answer is `hold`: the queue
 * merges nothing while the branch is red, which every sweep reads from the forge, so
 * nothing is written.
 *
 * Bound inputs: INPUTS_ASKED, what record asked; INPUTS_CHOICE and INPUTS_TEXT, the
 * attention answer.
 */

import { withBuild } from '../../.shared/build.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { appendSection } from '../../.shared/issue.ts';
import { type MergeAsked, type MergeAttention, type MergeDecisionEntry, type MergeStatus, withMerge } from '../../.shared/merge.ts';
import { chosen, rulingHeading } from '../../.shared/queue.ts';
import { updateClaimed } from '../../.shared/workitem.ts';

const STATUS = { merge: 'waiting', return: 'returned', park: 'parked' } as const satisfies Record<
  MergeAttention['choices'][number]['effect'],
  MergeStatus
>;

function main(): void {
  const asked = nullableJson(process.env.INPUTS_ASKED) as MergeAsked | null;
  if (asked === null) throw new Error('the answer arrived with nothing asked');
  const id = trimmed(process.env.INPUTS_CHOICE);
  const words = trimmed(process.env.INPUTS_TEXT);
  if (asked.by === 'dev') {
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
  const ruling = [choice.ruling.trim(), words === '' ? '' : `The maintainer's words: ${words}`]
    .filter(part => part !== '')
    .join('\n\n');
  const heading = ruling === '' ? '' : rulingHeading(at, `the merge queue's question on PR ${String(asked.pr.number)}`);
  if (ruling !== '') appendSection(asked.item, heading, ruling);

  const entry: MergeDecisionEntry = {
    at,
    run_id: runId,
    decision: `answered: ${choice.effect}`,
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
    summary: `PR ${String(asked.pr.number)}: the maintainer chose ${choice.id} (${choice.effect}).`,
  });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue ruling: ${error instanceof Error ? error.message : String(error)}`);
}
