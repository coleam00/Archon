/**
 * Start a discoveries drain after a sweep that merged a pull request.
 *
 * A discovery about code a pull request adds is at the default branch only once that
 * pull request merged, so a merge is when such records become decidable. The drain
 * starts through the operator's discoveries binding, keyed by this run, so one sweep
 * starts at most one drain. A sweep that merged nothing, or a queue with no binding
 * set, starts nothing; a drain that does not start is noted and fails nothing.
 *
 * Bound inputs: INPUTS_MERGED from record; the workflow's INPUTS_DISCOVERIES_BINDING,
 * INPUTS_REPO_HOST and INPUTS_REPO_PATH.
 */

import { followUp } from '../../.shared/follow-up.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';

function main(): void {
  const merged = (nullableJson(process.env.INPUTS_MERGED) ?? []) as number[];
  const binding = trimmed(process.env.INPUTS_DISCOVERIES_BINDING);
  if (merged.length === 0) {
    emit({ summary: 'This sweep merged nothing, so no discoveries drain starts.' });
    return;
  }
  if (binding === '') {
    emit({ summary: 'discoveries_binding is empty, so no discoveries drain starts.' });
    return;
  }
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  const repo = `${trimmed(process.env.INPUTS_REPO_HOST)}/${trimmed(process.env.INPUTS_REPO_PATH)}`;
  // The binding names the repository, so the drain takes no inputs.
  emit({ summary: followUp(binding, `discoveries-drain:${repo}:${runId}`, {}, 'a discoveries drain') });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue drain: ${error instanceof Error ? error.message : String(error)}`);
}
