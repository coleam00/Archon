/**
 * One return for every legitimate terminal result of the upkeep chain.
 *
 * A no_action assessment completes with the report that explains it; an update is
 * delivered when the deliver branch ran and reported its pull request ready, and
 * otherwise reports deliver's own reason. `delivered` is this workflow's authored
 * outcome: the run succeeded either way, and whether an update shipped is a
 * separate fact.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ACTION / INPUTS_SUMMARY: the assessment's verdict.
 * - INPUTS_DELIVERED / INPUTS_DELIVERY / INPUTS_PR_URL: deliver's `ready`, `summary`
 *   and `pr_url`, or "null" when the deliver branch was skipped (no_action).
 *
 * A failed delivery arrives as deliver's not-ready report, its summary saying a node
 * failed, and is relayed like any other not-ready delivery; the run still fails,
 * naming the node that failed.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const listingFile = process.env.TYPED_ARTIFACTS_FILE;
const action = text(process.env.INPUTS_ACTION);
const summary = text(process.env.INPUTS_SUMMARY);

if (action === 'no_action') {
  emit({
    delivered: false,
    pr_url: '',
    summary:
      `No update needed: ${summary}\nReport: ${artifacts}/upkeep-assessment.md` +
      caveats(artifacts, { listingFile }),
  });
} else {
  // Deliver ran, so its outcome is the report; its summary already carries the caveats.
  emit({
    delivered: text(process.env.INPUTS_DELIVERED) === 'true',
    pr_url: text(process.env.INPUTS_PR_URL),
    summary: text(process.env.INPUTS_DELIVERY),
  });
}
