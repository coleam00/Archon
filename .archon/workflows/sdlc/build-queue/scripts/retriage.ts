/**
 * Send the blocked items the revisit agent judged unblocked back to intake.
 *
 * Each gets this run's re-triage request and one intake pickup; intake decides whether
 * the item is now ready. The listing already recorded the revisit on every listed item.
 *
 * Bound inputs: INPUTS_REPO from start, INPUTS_BLOCKED from blocked, and
 * INPUTS_RETRIAGE from revisit.
 */

import type { BlockedItem } from '../../.shared/build.ts';
import { emit, input, refuse } from 'archon:script';
import { nullableJson } from '../../.shared/inputs.ts';
import { requestRetriage } from '../../.shared/launch.ts';

function main(): void {
  const blocked = nullableJson(input('blocked')) as BlockedItem[];
  const judged = nullableJson(input('retriage')) as { number: number; reason: string }[];
  const repo = nullableJson(input('repo')) as { host: string; path: string };
  const runId = (process.env.WORKFLOW_ID ?? '');
  const listed = new Set(blocked.map(item => item.number));
  const stray = judged.find(entry => !listed.has(entry.number));
  if (stray !== undefined) throw new Error(`the revisit named issue ${String(stray.number)}, which it was not given`);

  for (const { number } of judged) requestRetriage({ repo, number }, runId);
  emit({ retriaged: judged.map(entry => entry.number), summary: `Revisited ${String(blocked.length)} blocked item(s); sent ${String(judged.length)} to re-triage.` });
}

try {
  main();
} catch (error) {
  refuse(`build-queue retriage: ${error instanceof Error ? error.message : String(error)}`);
}
