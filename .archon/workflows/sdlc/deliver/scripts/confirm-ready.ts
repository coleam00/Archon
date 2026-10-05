/**
 * Certify the ready pull request on its final head, or put it back in draft.
 *
 * The one irreversible claim delivery makes is "ready for review", so this re-reads
 * everything itself instead of trusting the CI path above: every check green, every
 * check discover-ci expected present, and the CI fix's review (when one ran)
 * converged. Anything else — a pending, red, gated or unknown check, a failed read,
 * a missing expected check, an unconverged fix review — converts the pull request
 * back to draft and refuses with the reason. A red pull request never stays ready.
 *
 * It runs whatever happened on the CI path (`all_done`), so a failed CI step still
 * leaves the pull request in draft, and after the operator's re-run it marks a
 * now-green pull request ready again. Reads go through the source the run selected;
 * the draft conversion goes through gh (see ../../.shared/pr.ts).
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_EXPECTED: JSON list of the check names discover-ci expects to gate.
 * - INPUTS_REVIEW_ACTION: the CI fix's continuation review action, or `none`.
 */
import { atRevision, describeUnits, gateState, missingChecks, readPrChecks } from '../../.shared/checks.ts';
import { forgeSource, parsePrRecord, type PrRecord } from '../../.shared/forge.ts';
import { markPrDraft, markPrReady, viewPr } from '../../.shared/pr.ts';
import { emit, note, refuse, text, trimmed } from '../../.shared/io.ts';

/** Why the final head cannot stay ready, or undefined when it can. */
function unresolved(pr: PrRecord, expected: readonly string[]): string | undefined {
  if (trimmed(process.env.INPUTS_REVIEW_ACTION) !== 'none') {
    return 'the review of the CI fix did not converge';
  }
  let read;
  try {
    read = readPrChecks(pr);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const state = gateState(read.units);
  if (state !== 'green' && state !== 'none') {
    const notGreen = read.units.filter(unit => unit.state !== 'green');
    return `${state} checks${atRevision(read)}: ${describeUnits(notGreen)}`;
  }
  const missing = missingChecks(read.units, expected);
  if (missing.length > 0) return `expected check(s) never ran${atRevision(read)}: ${missing.join(', ')}`;
  return undefined;
}

function confirm(): void {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const source = forgeSource();
  const observed = viewPr(pr, source).pr;
  if (observed.state === 'merged') {
    note('confirm-ready: the PR was already merged.');
    emit({ pr_url: observed.url });
    return;
  }
  if (observed.state === 'closed') {
    throw new Error('the PR is CLOSED without a merge, so there is no delivery to report.');
  }
  const reason = unresolved(pr, JSON.parse(text(process.env.INPUTS_EXPECTED)) as string[]);
  if (reason !== undefined) {
    markPrDraft(pr);
    throw new Error(`the pull request is back in draft: ${reason}`);
  }
  emit({ pr_url: observed.is_draft ? markPrReady(pr, source).url : observed.url });
}

try {
  confirm();
} catch (error) {
  refuse(`confirm-ready: ${error instanceof Error ? error.message : String(error)}`);
}
