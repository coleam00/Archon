/**
 * The delivery tail's terminal report: ready, or not ready and why.
 *
 * Ready means the ci node judged CI green and flip-ready marked the pull request
 * ready, so the URL is flip-ready's read-back. Otherwise the pull request stays as
 * it was and the summary carries the ci node's reason: the root cause of a red, or
 * what CI is waiting for. Either way it appends whatever the run recorded for the
 * operator (red the gates let through, discoveries).
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_STATE / INPUTS_CI_SUMMARY: the ci node's verdict and its summary.
 * - INPUTS_PR_URL: `$flip-ready.output.pr_url`, or "null" when CI was not green.
 */

import { parsePrRecord } from '../../.shared/forge.ts';
import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { caveats } from '../../.shared/report.ts';

const artifacts = artifactsDir();
const listingFile = process.env.TYPED_ARTIFACTS_FILE;
const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
const state = text(process.env.INPUTS_STATE);
const flipped = text(process.env.INPUTS_PR_URL);

if (state === 'green') {
  emit({ ready: true, pr_url: flipped, summary: `${flipped}${caveats(artifacts, { listingFile })}` });
} else {
  const why = state === 'red' ? 'red' : 'CI has no result';
  emit({
    ready: false,
    pr_url: pr.url,
    summary:
      `Not ready, ${why}: ${text(process.env.INPUTS_CI_SUMMARY)}\n${pr.url}` +
      caveats(artifacts, { listingFile }),
  });
}
