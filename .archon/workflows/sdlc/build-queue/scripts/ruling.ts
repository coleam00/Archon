/**
 * Act on a person's answer to the build queue's attention item.
 *
 * The answer is one of the declared choices, and the wait returns that choice as the
 * answer's value, so its effect is read from the choice, never from the answer's text. The choice's ruling and the person's words are written
 * into the issue body as one dated "Current scope" section and read back, so the next
 * run and its review read the ruling as the contract. Then the answer is recorded on the
 * work item as the item's next owner, and the claim is released: `continue` keeps it in
 * the build queue, `ready` hands its pull request to the merge queue, and `park` stops
 * all work until a re-triage. A `continue` then starts the item's next build-queue run
 * at once through the operator's build-queue binding; if it does not start, the item
 * waits for the next queue run as before.
 *
 * Bound inputs: INPUTS_ITEM from facts; INPUTS_ASKED, what apply asked; INPUTS_CHOICE,
 * the chosen choice (the answer's value), and INPUTS_TEXT, the answer's text;
 * INPUTS_BUILD_QUEUE_BINDING, the workflow's input.
 */

import { type AskedBy, type BuildAttention, type BuildEffect, type BuildStatus, itemPullRequest, nextRound, withBuild } from '../../.shared/build.ts';
import { parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { appendSection } from '../../.shared/issue.ts';
import { type Choice, PRE_VALUE_ANSWER, rulingHeading } from '../../.shared/queue.ts';
import { readWorkItem, updateClaimed } from '../../.shared/workitem.ts';

interface Asked {
  readonly attention: BuildAttention;
  readonly brief: string;
  readonly by: AskedBy;
}

const STATUS = { continue: 'next', ready: 'ready', park: 'parked' } as const satisfies Record<
  BuildEffect,
  BuildStatus
>;

/** Refuse a ready answer before any write when the item has no pull request to hand on. */
function requireReadyPr(item: QualifiedPr, id: string): void {
  const doc = readWorkItem(item.number);
  if (doc === null || itemPullRequest(doc.facts.build?.rounds ?? [], doc.facts.triage, item.repo) === null) {
    throw new Error(`the ready choice "${id}" hands nothing to the merge queue: issue ${String(item.number)} has no pull request`);
  }
}

const ABOUT: Record<AskedBy, string> = {
  route: "the build queue's routing question",
  stop: "the build queue's question on a stopped run",
  scope: "the build queue's scope question",
};

function main(): void {
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  const asked = nullableJson(process.env.INPUTS_ASKED) as Asked | null;
  if (asked === null) throw new Error('the answer arrived with nothing asked');
  const choice = nullableJson(process.env.INPUTS_CHOICE) as Choice<BuildEffect> | null;
  if (choice === null) throw new Error(PRE_VALUE_ANSWER);
  const words = trimmed(process.env.INPUTS_TEXT);
  const at = new Date().toISOString();

  if (choice.effect === 'ready') requireReadyPr(item, choice.id);
  const ruling = [choice.ruling.trim(), words === '' ? '' : `The maintainer's words: ${words}`]
    .filter(part => part !== '')
    .join('\n\n');
  const heading = ruling === '' ? '' : rulingHeading(at, ABOUT[asked.by]);
  if (ruling !== '') appendSection(item, heading, ruling);

  const brief =
    choice.effect === 'continue'
      ? `${asked.brief}\n\nThe maintainer chose "${choice.label}": ${choice.does}${heading === '' ? '' : ` The ruling is the issue body's "${heading}" section, which is part of the contract.`}`
      : '';
  updateClaimed(item, runId, doc =>
    withBuild(doc, {
      at,
      run_id: runId,
      round: null,
      entry: {
        at,
        run_id: runId,
        decision: `answered: ${choice.effect}`,
        reason: choice.label,
        links: asked.attention.links,
        answer: { choice: choice.id, text: words, at },
      },
      status: STATUS[choice.effect],
      brief,
      release: true,
    })
  );
  const next = {
    continue: () => nextRound(item, runId),
    ready: () => 'its pull request waits for the merge queue',
    park: () => 'the queue stops working it until a re-triage',
  }[choice.effect]();
  emit({ decision: choice.effect, section: heading, summary: `Issue ${String(item.number)}: the maintainer chose ${choice.id}; ${next}.` });
}

try {
  main();
} catch (error) {
  refuse(`build-queue ruling: ${error instanceof Error ? error.message : String(error)}`);
}
