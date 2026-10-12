/**
 * One return for every legitimate terminal result of the upkeep chain.
 *
 * A no_action assessment completes with the report that explains it; when delivery
 * ran, its typed ending is the result. `delivered` is this workflow's authored
 * outcome: the run succeeded either way, and whether an update shipped is a separate
 * fact.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ACTION / INPUTS_SUMMARY: the assessment's verdict.
 * - INPUTS_DELIVER: archon-deliver's outcome `{ready, reason, pr_url, summary}`, or
 *   "null" when delivery was skipped (no_action).
 *
 * A failed delivery cannot reach this node: the failure
 * cascades an `upstream_failed` skip that blocks this join, and the run's terminal
 * record names the node that actually failed.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { discoveryReport } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const action = text(process.env.INPUTS_ACTION);
const summary = text(process.env.INPUTS_SUMMARY);
const deliver = JSON.parse(text(process.env.INPUTS_DELIVER) || 'null') as {
  ready: boolean;
  reason: string;
  summary: string;
} | null;

if (action === 'no_action' || deliver === null) {
  emit({
    delivered: false,
    summary:
      `No update needed: ${summary}\nReport: ${artifacts}/upkeep-assessment.md` +
      discoveryReport(artifacts),
  });
} else {
  emit({
    delivered: deliver.ready,
    summary:
      // Delivery's summary already relays the run's discoveries.
      `${deliver.ready ? 'Ready' : `Not ready (${deliver.reason})`}: ${deliver.summary}`,
  });
}
