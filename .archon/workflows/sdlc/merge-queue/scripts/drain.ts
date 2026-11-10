/**
 * Start a discoveries drain after a sweep that merged a pull request.
 *
 * A discovery about code a pull request adds is at the default branch only once that
 * pull request merged, so a merge is when such records become decidable. The drain
 * starts through the operator's discoveries binding, keyed by this run, so one sweep
 * starts at most one drain. A sweep that merged nothing, or a queue with no binding
 * set, starts nothing; a fire the binding does not admit is noted and fails nothing: the
 * next sweep that merges, or the drain's own schedule, starts one.
 *
 * Bound inputs: INPUTS_MERGED from record; the workflow's INPUTS_DISCOVERIES_BINDING.
 */

import { followUp } from '../../.shared/follow-up.ts';
import { emit, nullableJson, refuse, trimmed, workflowRunId } from '../../.shared/io.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';

function main(): void {
  const merged = (nullableJson(process.env.INPUTS_MERGED) ?? []) as NodeOutput<'archon-merge-queue', 'record'>['merged'];
  const binding = trimmed(process.env.INPUTS_DISCOVERIES_BINDING);
  if (merged.length === 0) {
    emit({ summary: 'This sweep merged nothing, so no discoveries drain starts.' });
    return;
  }
  if (binding === '') {
    emit({ summary: 'discoveries_binding is empty, so no discoveries drain starts.' });
    return;
  }
  const runId = workflowRunId();
  const later = 'the next sweep that merges, or a scheduled pass, starts one';
  // The binding names the repository, so the drain takes no inputs.
  emit({ summary: followUp(binding, `discoveries-drain:${runId}`, {}, 'a discoveries drain', later) });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue drain: ${error instanceof Error ? error.message : String(error)}`);
}
