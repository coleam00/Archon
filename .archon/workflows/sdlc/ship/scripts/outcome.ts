/**
 * One return for every terminal result of the routed chain.
 *
 * When delivery ran, its typed ending is the result. Otherwise the advisory stop that
 * kept it from running is: triage found no work owed or a non-ready contract, the item
 * needs human design, planning left a decision open, or the investigation did not prove
 * a fix boundary. `delivered` is this workflow's authored outcome.
 *
 * Bound inputs (canonical text; a skipped producer arrives as "null"):
 * - INPUTS_ROUTE / INPUTS_DESIGN_FIRST / INPUTS_SUMMARY: triage's verdict.
 * - INPUTS_DELIVER: archon-deliver's outcome `{ready, reason, pr_url, summary}`, or
 *   "null" when delivery was skipped.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { discoveryReport } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const route = text(process.env.INPUTS_ROUTE);
const designFirst = text(process.env.INPUTS_DESIGN_FIRST) === 'true';
const summary = text(process.env.INPUTS_SUMMARY);
const deliver = JSON.parse(text(process.env.INPUTS_DELIVER) || 'null') as {
  ready: boolean;
  reason: string;
  pr_url: string;
  summary: string;
} | null;

function stopped(reason: string, why: string, report: string): void {
  emit({
    delivered: false,
    reason,
    pr_url: '',
    summary: `${why}\nReport: ${artifacts}/${report}${discoveryReport(artifacts)}`,
  });
}

if (deliver !== null) {
  emit({
    delivered: deliver.ready,
    reason: deliver.ready ? 'delivered' : 'not_ready',
    pr_url: deliver.pr_url,
    summary:
      // Delivery's summary already relays the run's discoveries.
      `${deliver.ready ? 'Ready' : `Not ready (${deliver.reason})`}: ${deliver.summary}`,
  });
} else if (route === 'no_action') {
  stopped('no_action', `No delivery: ${summary}`, 'triage.md');
} else if (designFirst) {
  stopped('needs_design', `Needs human planning before any run: ${summary}`, 'triage.md');
} else if (route === 'investigate') {
  stopped(
    'not_rooted',
    'No delivery started: the investigation did not establish a safe fix boundary.',
    'investigation.md'
  );
} else {
  stopped(
    'plan_blocked',
    'No delivery started: planning left a material decision unresolved.',
    'plan.md'
  );
}
