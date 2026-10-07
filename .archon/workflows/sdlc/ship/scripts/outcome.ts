/**
 * One return for every legitimate terminal result of the routed fix chain.
 *
 * Negative advisory verdicts complete with the report that explains them; delivery is
 * accepted when the deliver branch actually ran and handed back the pull request it
 * opened. `delivered` is this workflow's authored outcome: an honest "no work is
 * owed" is a successful run that shipped nothing, and the two facts are separate.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ROUTE / INPUTS_SUMMARY / INPUTS_CONTRACT: triage's verdict. A negative
 *   contract verdict other than NO_ACTION (NEEDS_CONTRACT_WORK, BLOCKED) is named in
 *   the advisory report, so "the item needs work" never reads as "nothing to do".
 * - INPUTS_DELIVERED: `$deliver.output.pr_url`, the flip's certified URL, or "null"
 *   when the deliver branch was skipped (no_action, or an advisory stop upstream of
 *   the gates). The value is validated at the producer, so nothing here re-reads it
 *   for URL shape.
 *
 * A failed delivery cannot reach this node: the failure
 * cascades an `upstream_failed` skip that blocks this join, and the run's terminal
 * record names the node that actually failed.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const listingFile = process.env.TYPED_ARTIFACTS_FILE;
const route = text(process.env.INPUTS_ROUTE);
const summary = text(process.env.INPUTS_SUMMARY);
const contract = text(process.env.INPUTS_CONTRACT);
const delivered = text(process.env.INPUTS_DELIVERED) || 'null';

if (route === 'no_action') {
  const verdict = contract !== '' && contract !== 'NO_ACTION' ? ` [${contract}]` : '';
  emit({
    delivered: false,
    summary:
      `No delivery needed${verdict}: ${summary}\nReport: ${artifacts}/triage.md` +
      caveats(artifacts, { listingFile }),
  });
} else if (delivered === 'null') {
  const stop =
    route === 'investigate'
      ? {
          reason: 'the investigation did not establish a safe fix boundary',
          report: 'investigation.md',
        }
      : { reason: 'planning left a material decision unresolved', report: 'plan.md' };
  emit({
    delivered: false,
    summary:
      `No delivery started: ${stop.reason}.\nReport: ${artifacts}/${stop.report}` +
      caveats(artifacts, { listingFile }),
  });
} else {
  // Deliver ran, so the record it returned is the report.
  emit({ delivered: true, summary: delivered + caveats(artifacts, { listingFile }) });
}
