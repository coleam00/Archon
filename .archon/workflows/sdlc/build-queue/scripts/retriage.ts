/**
 * Send the blocked items the revisit agent judged unblocked back to intake.
 *
 * Each gets `archon-triage` and a detached intake run with that label event, recorded
 * as added by `retriage_as`; intake decides whether the item is now ready. Every listed
 * item records the revisit, so the next one waits its turn.
 *
 * Bound inputs: INPUTS_BLOCKED from blocked, INPUTS_RETRIAGE from revisit, and the
 * workflow inputs INPUTS_REPO_HOST, INPUTS_REPO_PATH and INPUTS_RETRIAGE_AS.
 */

import { type BlockedItem, recordRevisit } from '../../.shared/build.ts';
import { emit, note, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { launchDetached } from '../../.shared/launch.ts';
import { writeLabels } from '../../.shared/labels.ts';

function main(): void {
  const blocked = nullableJson(process.env.INPUTS_BLOCKED) as BlockedItem[];
  const judged = nullableJson(process.env.INPUTS_RETRIAGE) as { number: number; reason: string }[];
  const repo = { host: trimmed(process.env.INPUTS_REPO_HOST), path: trimmed(process.env.INPUTS_REPO_PATH) };
  const actor = trimmed(process.env.INPUTS_RETRIAGE_AS);
  const runId = text(process.env.WORKFLOW_ID);
  const listed = new Set(blocked.map(item => item.number));
  const stray = judged.find(entry => !listed.has(entry.number));
  if (stray !== undefined) throw new Error(`the revisit named issue ${String(stray.number)}, which it was not given`);

  const sent = new Map<number, string>();
  for (const { number, reason } of judged) {
    const item = { repo, number };
    writeLabels(item, ['archon-triage'], []);
    const intake = launchDetached('archon-intake', {
      repo_host: repo.host,
      repo_path: repo.path,
      number: String(number),
      action: 'added',
      label: 'archon-triage',
      label_actor: actor,
    });
    sent.set(number, `asked intake to re-triage (run ${intake}): ${reason}`);
  }
  for (const { number } of blocked) {
    if (!recordRevisit({ repo, number }, runId, sent.get(number) ?? 'judged still blocked')) {
      note(`issue ${String(number)}: the revisit was not recorded, so the next run judges it again`);
    }
  }
  emit({ retriaged: [...sent.keys()], summary: `Revisited ${String(blocked.length)} blocked item(s); sent ${String(sent.size)} to re-triage.` });
}

try {
  main();
} catch (error) {
  refuse(`build-queue retriage: ${error instanceof Error ? error.message : String(error)}`);
}
