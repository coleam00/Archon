/**
 * The delivery tail's terminal report: ready, or not ready and why.
 *
 * The last round's typed ending is the result: ready when its review converged and
 * the CI agent saw green and marked the pull request ready, otherwise the reason the
 * rounds stopped, in the deciding node's words. Either way it appends the
 * discoveries the run recorded for the operator.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ROUNDS: the rounds loop's final `round` output.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const rounds = JSON.parse(text(process.env.INPUTS_ROUNDS)) as {
  ready: boolean;
  reason: string;
  pr_url: string;
  summary: string;
};
const notes = caveats(artifactsDir(), { listingFile: process.env.TYPED_ARTIFACTS_FILE });
const where = rounds.pr_url === '' ? '' : `\n${rounds.pr_url}`;

emit({
  ready: rounds.ready,
  reason: rounds.reason,
  pr_url: rounds.pr_url,
  summary: `${rounds.ready ? 'Ready' : 'Not ready'}: ${rounds.summary}${where}${notes}`,
});
