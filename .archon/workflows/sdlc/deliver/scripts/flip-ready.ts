/**
 * Mark the pull request ready for review once the work is done: review converged and
 * the local gate is green for the tree. CI is waited on after this, not before: a
 * project whose CI skips draft pull requests only starts it here, and on one whose
 * CI also runs on drafts this changes nothing. confirm-ready, at the end, certifies
 * green on the final head and converts the pull request back to draft when it is not,
 * so a red pull request never stays ready.
 *
 * Before the flip it refuses a head that does not merge cleanly into its freshly
 * fetched base (../../.shared/remote.ts): a conflicting pull request is never handed
 * to a maintainer as ready. The flip targets the recorded qualified pull request through
 * the source the run selected, and reads the state back. A pull request already
 * merged needs no flip; one closed without a merge refuses.
 *
 * It reports when it flipped (`flipped_at`, null when the pull request was already
 * ready or merged): checks a draft skipped before that moment are not the ready
 * pull request's, and the CI wait reads them as not yet run.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */
import { forgeSource, parsePrRecord } from '../../.shared/forge.ts';
import { markPrReady, viewPr } from '../../.shared/pr.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';
import { assertMergesCleanly } from '../../.shared/remote.ts';

function flipReady(): void {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const source = forgeSource();
  const observed = viewPr(pr, source).pr;
  if (observed.state === 'merged') {
    note('flip-ready: the PR was already merged, so no flip was needed.');
    emit({ pr_url: observed.url, flipped_at: null });
    return;
  }
  if (observed.state === 'closed') {
    throw new Error('the PR is CLOSED without a merge, so there is no delivery to report.');
  }
  assertMergesCleanly(pr.repo, pr.base);
  if (!observed.is_draft) {
    emit({ pr_url: observed.url, flipped_at: null });
    return;
  }
  // Taken before the flip: every check that concluded earlier ran on the draft.
  const flippedAt = new Date().toISOString();
  emit({ pr_url: markPrReady(pr, source).url, flipped_at: flippedAt });
}

try {
  flipReady();
} catch (error) {
  refuse(`flip-ready: ${error instanceof Error ? error.message : String(error)}`);
}
