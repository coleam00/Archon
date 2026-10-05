/**
 * Certify the ready pull request on its final head, or put it back in draft.
 *
 * The one irreversible claim delivery makes is "ready for review", so this re-reads
 * everything itself instead of trusting the CI path above: every check green, every
 * check discover-ci expected present, and the CI fix's commits reviewed to
 * convergence when a fix was owed one. Anything else — a pending, red, gated or
 * unknown check, a failed read, a missing expected check, an unreviewed CI fix —
 * converts the pull request back to draft and refuses with the reason. A red pull
 * request never stays ready.
 *
 * It runs whatever happened on the CI path (`all_done`), so it binds no value a
 * failed node could have produced: whether the CI fix's review converged is read
 * from the run's typed records (`ci-cause`, `ci-fix-delta`, `ci-fix-review`), which
 * exist only for nodes that succeeded. A draft it marks ready again, after the
 * operator's re-run, passes the same merge check as the first flip. Reads go through
 * the source the run selected; the draft conversion goes through gh (see
 * ../../.shared/pr.ts).
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_EXPECTED: JSON list of the check names discover-ci expects to gate.
 */
import { atRevision, describeUnits, gateState, missingChecks, readPrChecks } from '../../.shared/checks.ts';
import { forgeSource, parsePrRecord, type PrRecord } from '../../.shared/forge.ts';
import { markPrDraft, markPrReady, viewPr } from '../../.shared/pr.ts';
import { artifactsDir, emit, note, refuse, text } from '../../.shared/io.ts';
import { assertMergesCleanly } from '../../.shared/remote.ts';
import { readTyped } from '../../.shared/typed.ts';

/**
 * Why the CI fix's commits still owe a converged review, or undefined. A fix for an
 * introduced red owes one unless it moved nothing; the review gate's record exists
 * only when that review converged. Fails closed when the records cannot be read.
 */
function unreviewedFix(): string | undefined {
  const listing = process.env.TYPED_ARTIFACTS_FILE;
  const artifacts = artifactsDir();
  const cause = readTyped<{ cause: string }>(listing, artifacts, 'ci-cause');
  if (cause.listingProblem !== undefined) return cause.listingProblem;
  if (cause.values.at(-1)?.cause !== 'introduced') return undefined;
  if (readTyped<{ moved: boolean }>(listing, artifacts, 'ci-fix-delta').values.at(-1)?.moved === false) {
    return undefined;
  }
  if (readTyped(listing, artifacts, 'ci-fix-review').values.length > 0) return undefined;
  return 'the review of the CI fix did not converge';
}

/** Why the final head cannot stay ready, or undefined when it can. */
function unresolved(pr: PrRecord, expected: readonly string[]): string | undefined {
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
  return unreviewedFix();
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
  if (observed.is_draft) {
    assertMergesCleanly(pr.repo, pr.base);
    emit({ pr_url: markPrReady(pr, source).url });
  } else {
    emit({ pr_url: observed.url });
  }
}

try {
  confirm();
} catch (error) {
  refuse(`confirm-ready: ${error instanceof Error ? error.message : String(error)}`);
}
