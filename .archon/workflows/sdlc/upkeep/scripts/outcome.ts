/**
 * One return for every legitimate terminal result of the upkeep chain.
 *
 * A no_action assessment completes with the report that explains it; a delivered
 * update is accepted when the deliver branch actually ran and handed back the pull
 * request it opened. `delivered` is this workflow's authored outcome: the run
 * succeeded either way, and whether an update shipped is a separate fact.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ACTION / INPUTS_SUMMARY: the assessment's verdict.
 * - INPUTS_DELIVERED: `$deliver.output.pr_url`, the flip's certified URL, or "null"
 *   when the deliver branch was skipped (no_action). The value is validated at the
 *   producer, so nothing here re-reads it for URL shape.
 *
 * A delivery that STARTED and died no longer reaches this node at all: the failure
 * cascades an `upstream_failed` skip that blocks this join, and the run's terminal
 * record names the node that actually failed.
 */

import { artifactsDir, emit, refuse, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

// Which actions exist is the assessment's vocabulary, declared in its own schema.
// Re-enumerating it here would be a second owner that nothing keeps in step, and an
// action this script does not recognise cannot open the spend gate, so it always
// arrives with no delivered value and refuses through the branch below.
const artifacts = artifactsDir();
const action = text(process.env.INPUTS_ACTION);
const summary = text(process.env.INPUTS_SUMMARY);
const delivered = text(process.env.INPUTS_DELIVERED) || 'null';

if (action === 'no_action') {
  emit({
    delivered: false,
    summary:
      `No update needed: ${summary}\nReport: ${artifacts}/upkeep-assessment.md` +
      caveats(artifacts, { failed: false }),
  });
} else if (delivered === 'null') {
  refuse(
    "outcome: the assessment chose 'update' but delivery never ran — " +
      "see the run's terminal record for the node it stopped at." +
      caveats(artifacts, { failed: true })
  );
} else {
  // Deliver ran, so the record it returned is the report.
  emit({ delivered: true, summary: delivered + caveats(artifacts, { failed: false }) });
}
