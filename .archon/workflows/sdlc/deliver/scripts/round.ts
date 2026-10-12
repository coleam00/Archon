/**
 * One delivery round's typed result, and whether the round loop is done.
 *
 * A loop_group that exhausts max_iterations fails the run instead of ending it with
 * a reason, so this node counts rounds itself and declares the run done at ROUND_CAP.
 * Everything else is read from the round's own typed outputs; nothing here judges.
 *
 * Bound inputs (canonical text; a skipped producer arrives as "null"):
 * - INPUTS_PREVIOUS / INPUTS_PRIOR_REPORT: the previous round's `round` and
 *   `prior_report`, and INPUTS_PREVIOUS_PR_URL its `pr_url` ('' on the first round).
 * - INPUTS_GREEN: implement's verdict. INPUTS_VALIDATED: validate's green.
 * - INPUTS_RED_CAUSE: validate's red cause. INPUTS_REVIEW_READY / INPUTS_REVIEW_ACTION:
 *   the review verdict. INPUTS_CI: the CI agent's state. INPUTS_PR_URL: the PR.
 * - INPUTS_*_SUMMARY: each node's summary; the one that decided the round is reported.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';

const ROUND_CAP = 3;

/** Why a round ended; `round_cap` is added only when the cap stops a round that would repeat. */
type Ended =
  | 'delivered'
  | 'implement_blocked'
  | 'validate_red'
  | 'review_open'
  | 'replan'
  | 'ci_pr_caused'
  | 'ci_other';

const previous = Number.parseInt(text(process.env.INPUTS_PREVIOUS), 10);
const round = (Number.isNaN(previous) ? 0 : previous) + 1;
const green = text(process.env.INPUTS_GREEN);
const validated = text(process.env.INPUTS_VALIDATED);
const redCause = text(process.env.INPUTS_RED_CAUSE);
const reviewReady = text(process.env.INPUTS_REVIEW_READY);
const reviewAction = text(process.env.INPUTS_REVIEW_ACTION);
const ci = text(process.env.INPUTS_CI);
const prUrl = text(process.env.INPUTS_PR_URL);
const priorReport = text(process.env.INPUTS_PRIOR_REPORT);
const previousPrUrl = text(process.env.INPUTS_PREVIOUS_PR_URL);

/** The reason this round ended, and whether another round can change it. */
function decide(): { reason: Ended; again: boolean } {
  if (green !== 'true') return { reason: 'implement_blocked', again: false };
  // A red the change did not cause still goes to review; CI judges it again.
  const passedGate =
    validated === 'true' || redCause === 'inherited' || redCause === 'environment';
  if (!passedGate) return { reason: 'validate_red', again: true };
  if (reviewReady !== 'true') {
    return reviewAction === 'replan'
      ? { reason: 'replan', again: false }
      : { reason: 'review_open', again: true };
  }
  if (ci === 'green') return { reason: 'delivered', again: false };
  if (ci === 'pr_caused') return { reason: 'ci_pr_caused', again: true };
  return { reason: 'ci_other', again: false };
}

const SUMMARY_OF: Record<Ended, string> = {
  delivered: 'CI_SUMMARY',
  implement_blocked: 'IMPLEMENT_SUMMARY',
  validate_red: 'VALIDATE_SUMMARY',
  review_open: 'REVIEW_SUMMARY',
  replan: 'REVIEW_SUMMARY',
  ci_pr_caused: 'CI_SUMMARY',
  ci_other: 'CI_SUMMARY',
};

const { reason, again } = decide();
const capped = again && round >= ROUND_CAP;

emit({
  round,
  done: !again || capped,
  ready: reason === 'delivered',
  reason: capped ? 'round_cap' : reason,
  pr_url: prUrl === 'null' ? previousPrUrl : prUrl,
  // The next round's review continues from the last published report, if any.
  prior_report: reviewReady === 'null' ? priorReport : `${artifactsDir()}/review/report.md`,
  summary: `Round ${round}: ${capped ? `${reason} at the ${ROUND_CAP}-round cap` : reason}. ${text(process.env[`INPUTS_${SUMMARY_OF[reason]}`])}`,
});
