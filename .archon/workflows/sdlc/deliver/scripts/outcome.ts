/**
 * The delivery tail's result when the rounds ran to an ending: ready, or not ready
 * and why. The `report` node relays it as the workflow's return.
 *
 * The last round's typed ending is the result: ready when its review converged and
 * the CI agent saw green and marked the pull request ready, otherwise the reason the
 * rounds stopped, in the deciding node's words. A last round that is not `done` means
 * the loop ran out at its `max_iterations`, which is the `round_cap` ending. Either way it lists the contract
 * items the latest review left open, then lists the discoveries the run recorded for
 * the operator.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ROUNDS: the rounds loop's final `round` output.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const rounds = JSON.parse(text(process.env.INPUTS_ROUNDS)) as {
  round: number;
  done: boolean;
  ready: boolean;
  reason: string;
  pr_url: string;
  contract_left: string[] | null;
  summary: string;
};
const capped = !rounds.done;
const notes = caveats(artifactsDir(), { listingFile: process.env.TYPED_ARTIFACTS_FILE });
const where = rounds.pr_url === '' ? '' : `\n${rounds.pr_url}`;
const left = rounds.contract_left?.length
  ? `\n\nLeft open, so the pull request does not close its issue:\n${rounds.contract_left.map(item => `- ${item}`).join('\n')}`
  : '';

emit({
  ready: rounds.ready,
  reason: capped ? 'round_cap' : rounds.reason,
  pr_url: rounds.pr_url,
  summary: `${rounds.ready ? 'Ready' : 'Not ready'}: ${rounds.summary}${capped ? ` Stopped at the ${rounds.round}-round cap.` : ''}${where}${left}${notes}`,
});
