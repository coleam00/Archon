/**
 * One return for every legitimate terminal result of the routed fix chain.
 *
 * Negative advisory verdicts complete with the report that explains them; delivery is
 * accepted when the deliver branch actually ran and handed back the pull request it
 * opened. `delivered` is this workflow's authored outcome: an honest "no work is
 * owed" is a successful run that shipped nothing, and the two facts are separate.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ROUTE / INPUTS_SUMMARY: triage's verdict.
 * - INPUTS_DELIVERED: `$deliver.output.pr_url`, the flip's certified URL, or "null"
 *   when the deliver branch was skipped (no_action, or an advisory stop upstream of
 *   the gates). The value is validated at the producer, so nothing here re-reads it
 *   for URL shape.
 *
 * A delivery that STARTED and died no longer reaches this node at all: the failure
 * cascades an `upstream_failed` skip that blocks this join, and the run's terminal
 * record names the node that actually failed. The spend gates' outputs used to be
 * bound here purely to tell that case apart from an advisory stop.
 */

import { artifactsDir, emit, refuse, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

/**
 * The advisory report a route stopped at, when stopping there is a valid result.
 *
 * Keyed by plain string on purpose. Which routes exist is triage's vocabulary,
 * declared in its own schema; re-enumerating it here would be a second owner that
 * nothing keeps in step. A route this table does not know still cannot reach a
 * delivered report — it opens no spend gate, so it always arrives with no delivered
 * value and refuses through the branch below.
 */
const ADVISORY_STOP: Record<string, { readonly reason: string; readonly report: string } | undefined> =
  {
    investigate: {
      reason: 'the investigation did not establish a safe fix boundary',
      report: 'investigation.md',
    },
    plan: { reason: 'planning left a material decision unresolved', report: 'plan.md' },
  };

const artifacts = artifactsDir();
const route = text(process.env.INPUTS_ROUTE);
const summary = text(process.env.INPUTS_SUMMARY);
const delivered = text(process.env.INPUTS_DELIVERED) || 'null';

if (route === 'no_action') {
  emit({
    delivered: false,
    summary:
      `No delivery needed: ${summary}\nReport: ${artifacts}/triage.md` +
      caveats(artifacts, { failed: false }),
  });
} else if (delivered === 'null') {
  const stop = ADVISORY_STOP[route];
  if (stop === undefined) {
    refuse(
      `outcome: route '${route}' skipped delivery without an advisory report ` +
        'to point to.' +
        caveats(artifacts, { failed: true })
    );
  } else {
    emit({
      delivered: false,
      summary:
        `No delivery started: ${stop.reason}.\nReport: ${artifacts}/${stop.report}` +
        caveats(artifacts, { failed: false }),
    });
  }
} else {
  // Deliver ran, so the record it returned is the report.
  emit({ delivered: true, summary: delivered + caveats(artifacts, { failed: false }) });
}
