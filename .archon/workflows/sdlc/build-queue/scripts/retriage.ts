/**
 * Send the blocked items the revisit agent judged unblocked back to intake.
 *
 * Each gets this run's re-triage request and one intake pickup; intake decides whether
 * the item is now ready. Every listed item records the revisit, so the next one waits
 * its turn.
 *
 * Bound inputs: INPUTS_REPO from start, INPUTS_BLOCKED from blocked, and
 * INPUTS_RETRIAGE from revisit.
 */

import { recordRevisit } from '../../.shared/build.ts';
import { emit, note, nullableJson, refuse, text } from '../../.shared/io.ts';
import { requestRetriage } from '../../.shared/launch.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';

function main(): void {
  const blocked = nullableJson(process.env.INPUTS_BLOCKED) as NodeOutput<'archon-build-queue', 'blocked'>['blocked'];
  const judged = nullableJson(process.env.INPUTS_RETRIAGE) as NodeOutput<'archon-build-queue', 'revisit'>['retriage'];
  const repo = nullableJson(process.env.INPUTS_REPO) as NodeOutput<'archon-build-queue', 'start'>['repo'];
  const runId = text(process.env.WORKFLOW_ID);
  const listed = new Set(blocked.map(item => item.number));
  const stray = judged.find(entry => !listed.has(entry.number));
  if (stray !== undefined) throw new Error(`the revisit named issue ${String(stray.number)}, which it was not given`);

  const sent = new Map<number, string>();
  for (const { number, reason } of judged) {
    const intake = requestRetriage({ repo, number }, runId);
    sent.set(number, `asked intake to re-triage (run ${intake}): ${reason}`);
  }
  for (const { number } of blocked) {
    if (!recordRevisit({ repo, number }, runId, sent.get(number) ?? 'judged still blocked')) {
      note(`issue ${String(number)}: the revisit was not recorded, so the next run judges it again`);
    }
  }
  emit<NodeOutput<'archon-build-queue', 'retriage'>>({ retriaged: [...sent.keys()], summary: `Revisited ${String(blocked.length)} blocked item(s); sent ${String(sent.size)} to re-triage.` });
}

try {
  main();
} catch (error) {
  refuse(`build-queue retriage: ${error instanceof Error ? error.message : String(error)}`);
}
