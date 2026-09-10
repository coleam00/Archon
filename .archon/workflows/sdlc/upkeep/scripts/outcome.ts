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

import { artifactsDir, emit, input, refuse } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const ACTIONS = ['update', 'no_action'] as const;
type Action = (typeof ACTIONS)[number];

const artifacts = artifactsDir();
const raw = input('ACTION');
const action: Action | undefined = ACTIONS.find(candidate => candidate === raw);
const summary = input('SUMMARY');
const delivered = input('DELIVERED') || 'null';

if (action === undefined) {
  refuse(
    `outcome: the assessment declared an action this tail does not handle: '${raw}'.` +
      caveats(artifacts, { failed: true })
  );
} else if (action === 'no_action') {
  emit({
    delivered: false,
    summary:
      `No update needed: ${summary}\nReport: ${artifacts}/upkeep-assessment.md` +
      caveats(artifacts, { failed: false }),
  });
} else if (delivered === 'null') {
  refuse(
    "outcome: the assessment chose 'update' but the spend gate never " +
      'passed — see the assessment stage.' +
      caveats(artifacts, { failed: true })
  );
} else {
  // Deliver ran, so the record it returned is the report.
  emit({ delivered: true, summary: delivered + caveats(artifacts, { failed: false }) });
}
