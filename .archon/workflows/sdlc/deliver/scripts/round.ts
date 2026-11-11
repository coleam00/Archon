/**
 * One delivery round's typed result, and whether the round loop is done. The loop's
 * `max_iterations` is the round cap: a round that would repeat at the cap leaves `done`
 * false and the loop completes with it, which `outcome` reports as `round_cap`.
 * Everything else is read from the round's own typed outputs; nothing here judges.
 *
 * Bound inputs (canonical text; a skipped producer arrives as "null"):
 * - INPUTS_PREVIOUS / INPUTS_PRIOR_REPORT / INPUTS_PREVIOUS_PR_URL: the previous round's
 *   `round`, `prior_report` and `pr_url` ('' on the first round).
 * - INPUTS_GREEN / INPUTS_RED_CAUSE: the implementer's verdict on the checks it ran.
 * - INPUTS_PR_URL: this round's pull request.
 * - INPUTS_REVIEW_READY / INPUTS_REVIEW_ACTION: the review verdict.
 * - INPUTS_REVIEW_CONTRACT_LEFT / INPUTS_PREVIOUS_CONTRACT_LEFT: what the review's
 *   contract coverage did not mark met, carried from the previous round when this
 *   round ran no review.
 * - INPUTS_SIMPLIFY: whether simplify recorded smaller shapes in shape.md.
 * - INPUTS_CI_STATE: the CI agent's state.
 * - INPUTS_THREADS_OPEN: how many review threads were still unresolved when the round
 *   ended; "null" when the threads node did not run (no pull request).
 * - INPUTS_SETTLE_ASK: whether settle-threads found a thread that needs a decision this run cannot make.
 * - INPUTS_*_SUMMARY: each node's summary; the one that decided the round is reported.
 */

import { artifactsDir, emit, input } from 'archon:script';
import { nullableJson } from '../../.shared/inputs.ts';

/** Why a round ended. */
type Ended =
  | 'delivered'
  | 'implement_blocked'
  | 'review_open'
  | 'threads_open'
  | 'simplify_open'
  | 'replan'
  | 'ask'
  | 'ci_pr_caused'
  | 'ci_other';

const previous = Number.parseInt(input('previous'), 10);
const round = (Number.isNaN(previous) ? 0 : previous) + 1;
const green = input('green');
const redCause = input('red_cause');
const reviewReady = input('review_ready');
const reviewAction = input('review_action');
const reviewSummary = process.env.INPUTS_REVIEW_SUMMARY;
const ci = input('ci_state');
const prUrl = input('pr_url');
const threadsOpen = input('threads_open');
const contractLeft = nullableJson(input('review_contract_left'));

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
  if (input('simplify') === 'true') {
    return { reason: 'simplify_open', again: true, summary: 'simplify recorded smaller shapes in shape.md.' };
  }
  const ciSummary = process.env.INPUTS_CI_SUMMARY;
  if (ci === 'pr_caused') return { reason: 'ci_pr_caused', again: true, summary: ciSummary };
  if (ci !== 'ready') return { reason: 'ci_other', again: false, summary: ciSummary };
  // An open thread is unjudged work; one settle-threads could not settle needs a decision.
  if (Number(threadsOpen) > 0) {
    return input('settle_ask') === 'true'
      ? { reason: 'ask', again: false, summary: process.env.INPUTS_SETTLE_SUMMARY }
      : { reason: 'threads_open', again: true, summary: process.env.INPUTS_THREADS_SUMMARY };
  }
  return { reason: 'delivered', again: false, summary: ciSummary };
}

const { reason, again, summary } = decide();

emit({
  round,
  done: !again,
  ready: reason === 'delivered',
  reason,
  // A round whose implementer stopped opens no pull request; an earlier round's stands.
  pr_url: prUrl === 'null' ? input('previous_pr_url') : prUrl,
  // The next round's review continues from the last published report, if any.
  prior_report:
    reviewReady === 'null' ? input('prior_report') : `${artifactsDir()}/review/report.md`,
  // The latest review's open contract items; null until a review has judged coverage.
  contract_left: contractLeft ?? nullableJson(input('previous_contract_left')),
  summary: summary ?? '',
});
