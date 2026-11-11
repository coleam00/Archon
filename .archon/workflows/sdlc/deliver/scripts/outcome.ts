/**
 * The delivery tail's result when the rounds ran to an ending: ready, or not ready
 * and why. The `report` node relays it as the workflow's return.
 *
 * The last round's typed ending is the result, with the summary of the node that
 * decided it. A last round that is not `done` means the loop ran out at its
 * `max_iterations`, which is the `round_cap` ending.
 *
 * Bound input: INPUTS_ROUNDS, the rounds loop's final `round` output.
 */

import { emit, input } from 'archon:script';

const rounds = JSON.parse(input('rounds')) as {
  done: boolean;
  ready: boolean;
  reason: string;
  pr_url: string;
  summary: string;
};

emit({
  ready: rounds.ready,
  reason: rounds.done ? rounds.reason : 'round_cap',
  pr_url: rounds.pr_url,
  summary: rounds.summary,
});
