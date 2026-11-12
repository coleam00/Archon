/**
 * Act on a person's answer to the build queue's attention item.
 *
 * The answer names one of the options the ask declared, so its effect is read from that
 * option's value, never from the answer's text. An `other` answer names none: its text
 * is the ruling and the item continues. The option's ruling and the person's words are written
 * into the issue body as one dated "Current scope" section and read back, so the next
 * run and its review read the ruling as the contract. Then the answer is recorded on the
 * work item as the item's next owner, and the claim is released: `continue` keeps it in
 * the build queue, `ready` hands its pull request to the merge queue, and `park` stops
 * all work until a re-triage. A `continue` then starts the item's next build-queue run
 * at once through the operator's build-queue binding; if it does not start, the item
 * waits for the next queue run as before.
 *
 * Bound inputs: INPUTS_ITEM from facts; INPUTS_ASKED, what apply asked; INPUTS_DECISION,
 * the id of the chosen option (`other` for the wait's own), and INPUTS_TEXT, the answer's text;
 * INPUTS_BUILD_QUEUE_BINDING, the workflow's input.
 */

import { type AskedBy, type BuildAsk, type BuildEffect, type BuildStatus, itemPullRequest, nextRound, withBuild } from '../../.shared/build.ts';
import { emit, input, refuse, runId as workflowRunId } from 'archon:script';
import { parseQualifiedPr, type QualifiedPr } from '../../.shared/identity.ts';
import { nullableJson } from '../../.shared/inputs.ts';
import { appendSection } from '../../.shared/issue.ts';
import { answeredChoice, rulingHeading } from '../../.shared/queue.ts';
import { readWorkItem, updateClaimed } from '../../.shared/workitem.ts';

interface Asked {
  readonly ask: BuildAsk;
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
  const runId = workflowRunId();
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  const asked = nullableJson(input('asked')) as Asked | null;
  if (asked === null) throw new Error('the answer arrived with nothing asked');
  const choice = answeredChoice(asked.ask, input('decision').trim(), 'continue');
  const { effect } = choice.value;
  const words = input('text').trim();
  const at = new Date().toISOString();

  if (effect === 'ready') requireReadyPr(item, choice.id);
  const ruling = [choice.value.ruling.trim(), words === '' ? '' : `The maintainer's words: ${words}`]
    .filter(part => part !== '')
    .join('\n\n');
  const heading = ruling === '' ? '' : rulingHeading(at, ABOUT[asked.by]);
  if (ruling !== '') appendSection(item, heading, ruling);

  const brief =
    effect === 'continue'
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
        decision: `answered: ${effect}`,
        reason: choice.label,
        links: [],
        answer: { choice: choice.id, text: words, at },
      },
      status: STATUS[effect],
      brief,
      release: true,
    })
  );
  const next = {
    continue: () => nextRound(item, runId),
    ready: () => 'its pull request waits for the merge queue',
    park: () => 'the queue stops working it until a re-triage',
  }[effect]();
  emit({ decision: effect, section: heading, summary: `Issue ${String(item.number)}: the maintainer chose ${choice.id}; ${next}.` });
}

try {
  main();
} catch (error) {
  refuse(`build-queue ruling: ${error instanceof Error ? error.message : String(error)}`);
}
