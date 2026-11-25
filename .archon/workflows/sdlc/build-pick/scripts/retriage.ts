/**
 * Send the blocked items the revisit agent judged unblocked back to intake.
 *
 * Each gets this run's re-triage request on its work item, naming the run, and one
 * intake pickup. No label is written, so no label event starts a second pickup, and no
 * maintainer is credited with the request; intake decides whether the item is now
 * ready. The listing already recorded the revisit on every listed item.
 *
 * Bound inputs: INPUTS_REPO from start, INPUTS_BLOCKED from blocked, and
 * INPUTS_RETRIAGE from revisit; the workflow's INPUTS_INTAKE_BINDING.
 */

import { type BlockedItem, startIntake } from '../../.shared/build.ts';
import { emit, input, refuse, runId as workflowRunId } from 'archon:script';
import { nullableJson } from '../../.shared/inputs.ts';
import { enqueue } from '../../.shared/workitem.ts';

function main(): void {
  const blocked = nullableJson(input('blocked')) as BlockedItem[];
  const judged = nullableJson(input('retriage')) as { number: number; reason: string }[];
  const repo = nullableJson(input('repo')) as { host: string; path: string };
  const runId = workflowRunId();
  const listed = new Set(blocked.map(item => item.number));
  const stray = judged.find(entry => !listed.has(entry.number));
  if (stray !== undefined) throw new Error(`the revisit named issue ${String(stray.number)}, which it was not given`);

  for (const { number } of judged) {
    const subject = { repo, number };
    enqueue(subject, { at: new Date().toISOString(), run_id: runId, action: 'retriage', label: null, actor: null, body_digest: null });
    startIntake(subject, runId, 'retriage');
  }
  emit({ retriaged: judged.map(entry => entry.number), summary: `Revisited ${String(blocked.length)} blocked item(s); sent ${String(judged.length)} to re-triage.` });
}

try {
  main();
} catch (error) {
  refuse(`build-pick retriage: ${error instanceof Error ? error.message : String(error)}`);
}
