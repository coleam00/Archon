/**
 * The delivery tail's terminal report: ready, or not ready and why.
 *
 * Ready means the review converged and the ci node, which marks the pull request
 * ready and puts it back to draft on red, judged CI green. A review that ended
 * asking for a replan reports that; otherwise the summary carries the ci node's
 * reason: the root cause of a red, or why CI gave no result. Either way it
 * appends whatever the run recorded for the operator (red the gates let through,
 * discoveries).
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_REVIEW_ACTION / INPUTS_CORRECTION_ACTION: the initial review's action, and
 *   the correction loop's final one, or "null" when the loop did not run.
 * - INPUTS_STATE / INPUTS_CI_SUMMARY: the ci node's verdict and summary, or "null"
 *   when it did not run.
 */

import { parsePrRecord } from '../../.shared/forge.ts';
import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const listingFile = process.env.TYPED_ARTIFACTS_FILE;
const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
const corrected = text(process.env.INPUTS_CORRECTION_ACTION);
const action = corrected === 'null' ? text(process.env.INPUTS_REVIEW_ACTION) : corrected;
const state = text(process.env.INPUTS_STATE);
const notes = caveats(artifacts, { listingFile });

if (state === 'green') {
  emit({ ready: true, pr_url: pr.url, summary: `${pr.url}${notes}` });
} else {
  const why =
    action !== 'none'
      ? 'the review asks for a replan: the requested outcome needs work outside the accepted scope. See the review comment on the pull request'
      : `${state === 'red' ? 'red' : 'blocked'}: ${text(process.env.INPUTS_CI_SUMMARY)}`;
  emit({ ready: false, pr_url: pr.url, summary: `Not ready, ${why}\n${pr.url}${notes}` });
}
