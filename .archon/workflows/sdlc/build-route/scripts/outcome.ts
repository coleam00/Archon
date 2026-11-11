/**
 * The result of every legitimate ending of the routed fix chain, which the `report`
 * node relays as the workflow's return.
 *
 * Delivery is accepted when the deliver branch ran and reported its pull request
 * ready; a delivery that ended not ready reports deliver's own reason. Every other
 * completion reports why nothing was delivered: a typed reason and the deciding node's
 * own summary, led by "No delivery", so a completed run that shipped nothing never
 * reads as a success it is not.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ROUTE / INPUTS_CONTRACT / INPUTS_BLOCKED_REASON / INPUTS_SUMMARY:
 *   triage's verdict.
 * - INPUTS_INV_VERDICT / INPUTS_INV_SUMMARY: the investigation's verdict and
 *   summary, or "null" when it did not run.
 * - INPUTS_PLAN_SUMMARY / INPUTS_OPEN_QUESTIONS: the planner's summary and the calls it
 *   left to be asked, or "null" when it did not run.
 * - INPUTS_DELIVERED / INPUTS_DELIVERY / INPUTS_DELIVERY_REASON / INPUTS_PR_URL:
 *   deliver's `ready`, `summary`, `reason` and `pr_url`, or "null" when the deliver
 *   branch was skipped.
 * - INPUTS_REVIEWS: every `review-report` output of this run.
 *
 * A failed delivery arrives as deliver's `ready: false` report, reason `failed` or
 * `pr_create_unresolved`, and is relayed like any other not-ready delivery. A failure
 * before delivery skips this node; the workflow's `report` node answers then.
 */

import { artifactsDir, emit, text, typedOutputs } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const reviews = typedOutputs(process.env.INPUTS_REVIEWS);
const route = text(process.env.INPUTS_ROUTE);
const contract = text(process.env.INPUTS_CONTRACT);
const blockedReason = text(process.env.INPUTS_BLOCKED_REASON);
const summary = text(process.env.INPUTS_SUMMARY);
/** A string binding with `if_skipped: null`: the producer's text, or null when it was skipped. */
function optional(value: string | undefined): string | null {
  const bound = text(value);
  return bound === 'null' ? null : bound;
}

const invVerdict = optional(process.env.INPUTS_INV_VERDICT);
const invSummary = optional(process.env.INPUTS_INV_SUMMARY);
const planSummary = optional(process.env.INPUTS_PLAN_SUMMARY);
const openQuestions = JSON.parse(text(process.env.INPUTS_OPEN_QUESTIONS) || 'null') as
  | string[]
  | null;
const delivered = text(process.env.INPUTS_DELIVERED) || 'null';
const delivery = text(process.env.INPUTS_DELIVERY);

/** Why no delivery ran. */
type Stop = 'no_action' | 'blocked' | 'needs_contract' | 'split' | 'refuted' | 'not_rooted' | 'ask';

/**
 * The planner's open questions as a list. Each carries the direction line that would
 * settle it next time; the operator decides whether to record it.
 */
function questions(): string {
  return (openQuestions ?? []).map(question => `- ${question}`).join('\n');
}

/**
 * Why no delivery ran: the reason the build queue reads, the words of the node that
 * decided it, and that node's report.
 */
function stopped(): { readonly reason: Stop; readonly text: string; readonly report: string } {
  if (contract === 'NO_ACTION') return { reason: 'no_action', text: summary, report: 'triage.md' };
  if (contract === 'BLOCKED') return { reason: 'blocked', text: `${summary} Blocked on: ${blockedReason}`, report: 'triage.md' };
  if (contract !== 'READY') return { reason: 'needs_contract', text: summary, report: 'triage.md' };
  if (route === 'split') return { reason: 'split', text: summary, report: 'triage.md' };
  if (route === 'investigate') {
    return { reason: invVerdict === 'refuted' ? 'refuted' : 'not_rooted', text: invSummary ?? '', report: 'investigation.md' };
  }
  return { reason: 'ask', text: `${planSummary ?? ''}\n${questions() || '- The planner named no question; read the plan.'}`, report: 'plan.md' };
}

if (delivered === 'null') {
  const stop = stopped();
  emit({
    delivered: false,
    reason: stop.reason,
    pr_url: '',
    summary: `No delivery (${stop.reason}): ${stop.text.trim()}\nReport: ${artifacts}/${stop.report}` + caveats(artifacts, { reviews }),
  });
} else {
  // Deliver ran, so its outcome is the report; its summary already carries the caveats.
  // Questions the planner judged non-blocking still reach the operator.
  const open = questions();
  emit({
    delivered: delivered === 'true',
    reason: text(process.env.INPUTS_DELIVERY_REASON),
    pr_url: text(process.env.INPUTS_PR_URL),
    summary: open === '' ? delivery : `${delivery}\n\nOpen questions the planner judged non-blocking:\n${open}`,
  });
}
