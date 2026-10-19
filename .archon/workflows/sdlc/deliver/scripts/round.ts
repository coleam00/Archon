/**
 * One delivery round's typed result, and whether the round loop is done.
 *
 * A loop_group that exhausts max_iterations fails the run instead of ending it with
 * a reason, so this node counts rounds itself and declares the run done at ROUND_CAP.
 * Everything else is read from the round's own typed outputs; nothing here judges.
 * It also says whether the next round's review is light: after a CI fix, the
 * general code reviewer alone on the delta; otherwise the code lens and the lenses
 * the route agent selects, on the delta.
 *
 * Bound inputs (canonical text; a skipped producer arrives as "null"):
 * - INPUTS_PREVIOUS / INPUTS_PRIOR_REPORT / INPUTS_PREVIOUS_PR_URL: the previous round's
 *   `round`, `prior_report` and `pr_url` ('' on the first round).
 * - INPUTS_GREEN / INPUTS_RED_CAUSE: the implementer's verdict on the checks it ran.
 * - INPUTS_PR_URL: this round's pull request.
 * - INPUTS_REVIEW_READY / INPUTS_REVIEW_ACTION: the review verdict.
 * - INPUTS_REREVIEW_*: the light review of reshape's delta, which decides in the
 *   review's place when it ran.
 * - INPUTS_REVIEW_CONTRACT_LEFT / INPUTS_REREVIEW_CONTRACT_LEFT / INPUTS_PREVIOUS_CONTRACT_LEFT:
 *   what the deciding review's contract coverage did not mark met, carried from the
 *   previous round when this round ran no review.
 * - INPUTS_CI: the CI agent's state.
 * - INPUTS_THREADS_OPEN: how many review threads were still unresolved when the round
 *   ended; "null" when the threads node did not run (the forge source, or no pull request).
 * - INPUTS_SETTLE_ASK: whether settle-threads found a thread that needs a decision this run cannot make.
 * - INPUTS_*_SUMMARY: each node's summary; the one that decided the round is reported.
 */

import { artifactsDir, emit, nullableJson, text } from '../../.shared/io.ts';

const ROUND_CAP = 4;

/** Why a round ended; `round_cap` is added only when the cap stops a round that would repeat. */
type Ended =
  | 'delivered'
  | 'implement_blocked'
  | 'review_open'
  | 'threads_open'
  | 'replan'
  | 'ask'
  | 'ci_pr_caused'
  | 'ci_other';

const previous = Number.parseInt(text(process.env.INPUTS_PREVIOUS), 10);
const round = (Number.isNaN(previous) ? 0 : previous) + 1;
const green = text(process.env.INPUTS_GREEN);
const redCause = text(process.env.INPUTS_RED_CAUSE);
const rereviewed = ['true', 'false'].includes(text(process.env.INPUTS_REREVIEW_READY));
// Every binding is read by its literal name: the load-time binding check cannot see a computed key.
const reviewReady = text(rereviewed ? process.env.INPUTS_REREVIEW_READY : process.env.INPUTS_REVIEW_READY);
const reviewAction = text(rereviewed ? process.env.INPUTS_REREVIEW_ACTION : process.env.INPUTS_REVIEW_ACTION);
const reviewSummary = rereviewed ? process.env.INPUTS_REREVIEW_SUMMARY : process.env.INPUTS_REVIEW_SUMMARY;
const ci = text(process.env.INPUTS_CI);
const prUrl = text(process.env.INPUTS_PR_URL);
const threadsOpen = text(process.env.INPUTS_THREADS_OPEN);
const contractLeft = nullableJson(
  rereviewed ? process.env.INPUTS_REREVIEW_CONTRACT_LEFT : process.env.INPUTS_REVIEW_CONTRACT_LEFT
);

/** The reason this round ended, whether another round can change it, and the deciding node's summary. */
function decide(): { reason: Ended; again: boolean; summary: string | undefined } {
  // A validation red the change did not cause still goes to review; CI judges it again.
  const handedOff = green === 'true' || redCause === 'inherited' || redCause === 'environment';
  if (!handedOff) return { reason: 'implement_blocked', again: false, summary: process.env.INPUTS_IMPLEMENT_SUMMARY };
  if (reviewReady !== 'true') {
    // Neither a new plan nor a decision this run cannot make comes from another round.
    if (reviewAction === 'replan' || reviewAction === 'ask') {
      return { reason: reviewAction, again: false, summary: reviewSummary };
    }
    return { reason: 'review_open', again: true, summary: reviewSummary };
  }
  const ciSummary = process.env.INPUTS_CI_SUMMARY;
  if (ci === 'pr_caused') return { reason: 'ci_pr_caused', again: true, summary: ciSummary };
  if (ci !== 'green') return { reason: 'ci_other', again: false, summary: ciSummary };
  // An open thread is unjudged work; one settle-threads could not settle needs a decision.
  if (Number(threadsOpen) > 0) {
    return text(process.env.INPUTS_SETTLE_ASK) === 'true'
      ? { reason: 'ask', again: false, summary: process.env.INPUTS_SETTLE_SUMMARY }
      : { reason: 'threads_open', again: true, summary: process.env.INPUTS_THREADS_SUMMARY };
  }
  return { reason: 'delivered', again: false, summary: ciSummary };
}

const { reason, again, summary } = decide();
const capped = again && round >= ROUND_CAP;

emit({
  round,
  done: !again || capped,
  ready: reason === 'delivered',
  reason: capped ? 'round_cap' : reason,
  // A round whose implementer stopped opens no pull request; an earlier round's stands.
  pr_url: prUrl === 'null' ? text(process.env.INPUTS_PREVIOUS_PR_URL) : prUrl,
  // The next round's review continues from the last published report, if any.
  // A correction for CI gets a light review: the code lens alone, on the delta.
  light_review: reason === 'ci_pr_caused',
  // A round whose CI agent never ran re-ran nothing.
  prior_report:
    reviewReady === 'null' ? text(process.env.INPUTS_PRIOR_REPORT) : `${artifactsDir()}/review/report.md`,
  // The latest review's open contract items; null until a review has judged coverage.
  contract_left: contractLeft ?? nullableJson(process.env.INPUTS_PREVIOUS_CONTRACT_LEFT),
  summary: `Round ${round}: ${capped ? `${reason} at the ${ROUND_CAP}-round cap` : reason}. ${text(summary)}`,
});
