/**
 * The result of every legitimate ending of the routed fix chain, which the `report`
 * node relays as the workflow's return.
 *
 * A delivery that ran is reported as deliver reported it, ready or not. Every other
 * completion is not delivered, with a typed reason and the summary of the node that
 * decided it, in that node's own words. The reason is what a caller branches on; the
 * deciding node's report (`triage.md`, `investigation.md` or `plan.md` in the run's
 * artifacts) holds the detail, such as the planner's open questions.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ROUTE / INPUTS_CONTRACT / INPUTS_SUMMARY: triage's verdict.
 * - INPUTS_INV_VERDICT / INPUTS_INV_SUMMARY: the investigation's verdict and
 *   summary, or "null" when it did not run.
 * - INPUTS_PLAN_SUMMARY: the planner's summary, or "null" when it did not run.
 * - INPUTS_DELIVERED / INPUTS_DELIVERY / INPUTS_DELIVERY_REASON / INPUTS_PR_URL:
 *   deliver's `ready`, `summary`, `reason` and `pr_url`, or "null" when the deliver
 *   branch was skipped.
 *
 * A failed delivery arrives as deliver's `ready: false` report, reason `failed` or
 * `pr_create_unresolved`, and is relayed like any other not-ready delivery. A failure
 * before delivery skips this node; the workflow's `report` node answers then.
 */

import { emit, text } from '../../.shared/io.ts';

const route = text(process.env.INPUTS_ROUTE);
const contract = text(process.env.INPUTS_CONTRACT);
const summary = text(process.env.INPUTS_SUMMARY);
const delivered = text(process.env.INPUTS_DELIVERED) || 'null';

/** Why no delivery ran. */
type Stop = 'no_action' | 'blocked' | 'needs_contract' | 'split' | 'refuted' | 'not_rooted' | 'ask';

/** Why no delivery ran: the reason a caller reads, and the summary of the node that decided it. */
function stopped(): { readonly reason: Stop; readonly summary: string } {
  if (contract === 'NO_ACTION') return { reason: 'no_action', summary };
  if (contract === 'BLOCKED') return { reason: 'blocked', summary };
  if (contract !== 'READY') return { reason: 'needs_contract', summary };
  if (route === 'split') return { reason: 'split', summary };
  if (route === 'investigate') {
    const refuted = text(process.env.INPUTS_INV_VERDICT) === 'refuted';
    return { reason: refuted ? 'refuted' : 'not_rooted', summary: text(process.env.INPUTS_INV_SUMMARY) };
  }
  return { reason: 'ask', summary: text(process.env.INPUTS_PLAN_SUMMARY) };
}

if (delivered === 'null') {
  emit({ delivered: false, pr_url: '', ...stopped() });
} else {
  emit({
    delivered: delivered === 'true',
    reason: text(process.env.INPUTS_DELIVERY_REASON),
    pr_url: text(process.env.INPUTS_PR_URL),
    summary: text(process.env.INPUTS_DELIVERY),
  });
}
