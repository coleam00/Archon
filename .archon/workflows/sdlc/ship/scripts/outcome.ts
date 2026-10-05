/**
 * One return for every legitimate terminal result of the routed fix chain.
 *
 * Delivery is accepted when the deliver branch actually ran and handed back the
 * pull request it flipped. Every other completion reports, in the producing node's
 * own words, why nothing was delivered — and says plainly when requested work was
 * not done, so a completed run that shipped nothing never reads as a success it is
 * not. `delivered` is this workflow's authored outcome: an honest "no work is owed"
 * is a successful run that shipped nothing, and the two facts are separate.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ROUTE / INPUTS_CONTRACT / INPUTS_BLOCKED_REASON / INPUTS_SUMMARY:
 *   triage's verdict.
 * - INPUTS_INV_VERDICT / INPUTS_INV_SUMMARY: the investigation's verdict and
 *   summary, or "null" when it did not run.
 * - INPUTS_PLAN_SUMMARY: the planner's summary, or "null" when it did not run.
 * - INPUTS_DELIVERED: `$deliver.output.pr_url`, the flip's certified URL, or "null"
 *   when the deliver branch was skipped.
 *
 * A failed delivery cannot reach this node: the failure cascades an
 * `upstream_failed` skip that blocks this join, and the run's terminal record names
 * the node that actually failed.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const listingFile = process.env.TYPED_ARTIFACTS_FILE;
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
const delivered = text(process.env.INPUTS_DELIVERED) || 'null';

function stopped(): { readonly text: string; readonly report: string } {
  if (route === 'no_action') {
    if (contract === 'NO_ACTION') return { text: `No delivery needed: ${summary}`, report: 'triage.md' };
    if (contract === 'BLOCKED') {
      return { text: `Not done: blocked on ${blockedReason}. ${summary}`, report: 'triage.md' };
    }
    return {
      text: `Not done: the work item needs contract work before a run can start. ${summary}`,
      report: 'triage.md',
    };
  }
  if (route === 'investigate') {
    if (invVerdict === 'refuted') {
      return { text: `No work owed in this repository: ${invSummary ?? ''}`, report: 'investigation.md' };
    }
    return { text: `Not done: the investigation was inconclusive. ${invSummary ?? ''}`, report: 'investigation.md' };
  }
  return { text: `Not done: planning stopped. ${planSummary ?? ''}`, report: 'plan.md' };
}

if (delivered === 'null') {
  const stop = stopped();
  emit({
    delivered: false,
    summary: `${stop.text.trim()}\nReport: ${artifacts}/${stop.report}` + caveats(artifacts, { listingFile }),
  });
} else {
  // Deliver ran, so the record it returned is the report.
  emit({ delivered: true, summary: delivered + caveats(artifacts, { listingFile }) });
}
