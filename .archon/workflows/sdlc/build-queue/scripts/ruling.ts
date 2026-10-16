/**
 * Act on the answer to the build queue's attention item.
 *
 * The answer is one of the declared choices, so its effect is read from the choice,
 * never from the answer's text. The choice's ruling and the answer's text are written
 * into the issue body as one dated "Current scope" section and read back, so the next
 * run and its review read the ruling as the contract. Then the answer is recorded on the
 * work item, which says what happens next, and the claim is released.
 *
 * Bound inputs: INPUTS_ITEM from facts; INPUTS_ASKED, what apply asked; INPUTS_CHOICE
 * and INPUTS_TEXT, the attention answer.
 */

import { type AskedBy, type BuildAttention, withBuild } from '../../.shared/build.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { appendSection } from '../../.shared/issue.ts';
import { chosen, rulingHeading } from '../../.shared/queue.ts';
import { updateClaimed } from '../../.shared/workitem.ts';

interface Asked {
  readonly attention: BuildAttention;
  readonly brief: string;
  readonly by: AskedBy;
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
  const choice = chosen(asked.attention, trimmed(process.env.INPUTS_CHOICE));
  const words = trimmed(process.env.INPUTS_TEXT);
  const at = new Date().toISOString();

  const ruling = [choice.ruling.trim(), words === '' ? '' : `The answer's text: ${words}`]
    .filter(part => part !== '')
    .join('\n\n');
  const heading = ruling === '' ? '' : rulingHeading(at, ABOUT[asked.by]);
  if (ruling !== '') appendSection(item, heading, ruling);

  const brief =
    choice.effect === 'continue'
      ? `${asked.brief}\n\nThe answer chose "${choice.label}": ${choice.does}${heading === '' ? '' : ` The ruling is the issue body's "${heading}" section, which is part of the contract.`}`
      : '';
  updateClaimed(item, runId, doc =>
    withBuild(doc, {
      at,
      run_id: runId,
      round: null,
      entry: {
        at,
        run_id: runId,
        decision: choice.effect === 'continue' ? 'answered: continue' : 'answered: park',
        reason: choice.label,
        links: asked.attention.links,
        answer: { choice: choice.id, text: words, at },
      },
      status: choice.effect === 'continue' ? 'next' : 'parked',
      brief,
      release: true,
    })
  );
  emit({
    decision: choice.effect,
    section: heading,
    summary: `Issue ${String(item.number)}: the answer chose ${choice.id}; ${choice.effect === 'continue' ? 'the next run launches from the ruling' : 'the queue stops working it until a re-triage'}.`,
  });
}

try {
  main();
} catch (error) {
  refuse(`build-queue ruling: ${error instanceof Error ? error.message : String(error)}`);
}
