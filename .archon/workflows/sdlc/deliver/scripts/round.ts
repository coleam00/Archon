/**
 * One delivery round's typed result, and whether the round loop is done.
 *
 * A loop_group that exhausts max_iterations fails the run instead of ending it with
 * a reason, so this node counts rounds itself and declares the run done at ROUND_CAP.
 * Everything else is read from the round's own typed outputs; nothing here judges.
 * It also says how the next round's review runs: after a CI fix, the general code
 * reviewer alone on the delta (`light`); otherwise the same lenses on the delta.
 *
 * Bound inputs (canonical text; a skipped producer arrives as "null"):
 * - INPUTS_PREVIOUS / INPUTS_PRIOR_REPORT / INPUTS_PREVIOUS_PR_URL: the previous round's
 *   `round`, `prior_report` and `pr_url` ('' on the first round).
 * - INPUTS_GREEN / INPUTS_RED_CAUSE: the implementer's verdict on the checks it ran.
 * - INPUTS_PR_URL: this round's pull request.
 * - INPUTS_REVIEW_READY / INPUTS_REVIEW_ACTION: the review verdict.
 * - INPUTS_CI: the CI agent's state.
 * - INPUTS_*_SUMMARY: each node's summary; the one that decided the round is reported.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';

const ROUND_CAP = 3;

/** Why a round ended; `round_cap` is added only when the cap stops a round that would repeat. */
type Ended =
  | 'delivered'
  | 'implement_blocked'
  | 'review_open'
  | 'replan'
  | 'ci_pr_caused'
  | 'ci_other';

const previous = Number.parseInt(text(process.env.INPUTS_PREVIOUS), 10);
const round = (Number.isNaN(previous) ? 0 : previous) + 1;
const green = text(process.env.INPUTS_GREEN);
const redCause = text(process.env.INPUTS_RED_CAUSE);
const reviewReady = text(process.env.INPUTS_REVIEW_READY);
const reviewAction = text(process.env.INPUTS_REVIEW_ACTION);
const ci = text(process.env.INPUTS_CI);
const prUrl = text(process.env.INPUTS_PR_URL);

/** The reason this round ended, and whether another round can change it. */
function decide(): { reason: Ended; again: boolean } {
  // A validation red the change did not cause still goes to review; CI judges it again.
  const handedOff = green === 'true' || redCause === 'inherited' || redCause === 'environment';
  if (!handedOff) return { reason: 'implement_blocked', again: false };
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
  // A round whose implementer stopped opens no pull request; an earlier round's stands.
  pr_url: prUrl === 'null' ? text(process.env.INPUTS_PREVIOUS_PR_URL) : prUrl,
  // The next round's review continues from the last published report, if any.
  next_review: reason === 'ci_pr_caused' ? 'light' : 'delta',
  prior_report:
    reviewReady === 'null' ? text(process.env.INPUTS_PRIOR_REPORT) : `${artifactsDir()}/review/report.md`,
  summary: `Round ${round}: ${capped ? `${reason} at the ${ROUND_CAP}-round cap` : reason}. ${text(process.env[`INPUTS_${SUMMARY_OF[reason]}`])}`,
});
