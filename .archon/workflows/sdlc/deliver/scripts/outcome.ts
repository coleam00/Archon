/**
 * The delivery tail's terminal report: ready, or not ready and why.
 *
 * Ready means the review converged and CI ended green; the ci agent marked the pull
 * request ready. A review that ended asking for a replan reports
 * that; otherwise the summary carries the ci node's reason: the root cause of a red
 * the change did not cause, or why CI gave no result. Either way it appends whatever
 * the run recorded for the operator (red the gates let through, discoveries).
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_REVIEW_ACTION: the initial review's action.
 * - INPUTS_FIRST_STATE / INPUTS_FIRST_SUMMARY: CI's verdict when the initial review
 *   converged, or "null" when it did not.
 * - INPUTS_ACTION / INPUTS_STATE / INPUTS_CI_SUMMARY: the last correction round's
 *   review action, CI verdict and CI summary, or "null" when no round ran.
 */

import { parsePrRecord } from '../../.shared/forge.ts';
import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const listingFile = process.env.TYPED_ARTIFACTS_FILE;
const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
const rounded = text(process.env.INPUTS_ACTION) !== 'null';
const action = rounded ? text(process.env.INPUTS_ACTION) : text(process.env.INPUTS_REVIEW_ACTION);
const state = text(rounded ? process.env.INPUTS_STATE : process.env.INPUTS_FIRST_STATE);
const ciSummary = text(rounded ? process.env.INPUTS_CI_SUMMARY : process.env.INPUTS_FIRST_SUMMARY);
const notes = caveats(artifacts, { listingFile });

if (action === 'none' && state === 'green') {
  emit({ ready: true, pr_url: pr.url, summary: `${pr.url}${notes}` });
} else {
  const why =
    action !== 'none'
      ? 'the review asks for a replan: the requested outcome needs work outside the accepted scope. See the review comment on the pull request'
      : `${state === 'red' ? 'red' : 'blocked'}: ${ciSummary}`;
  emit({ ready: false, pr_url: pr.url, summary: `Not ready, ${why}\n${pr.url}${notes}` });
}
