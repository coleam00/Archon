/**
 * Mark the pull request ready for review. It runs only when the ci node judged CI
 * green on the delivered head, so a red pull request is never made ready.
 *
 * Before the flip it refuses a head that does not merge cleanly into its freshly
 * fetched base (../../.shared/remote.ts): a conflicting pull request is never handed
 * to a maintainer as ready. The flip targets the recorded qualified pull request through
 * the source the run selected, and reads the state back. A pull request already
 * merged needs no flip; one closed without a merge refuses.
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
    emit({ pr_url: observed.url });
    return;
  }
  if (observed.state === 'closed') {
    throw new Error('the PR is CLOSED without a merge, so there is no delivery to report.');
  }
  assertMergesCleanly(pr.repo, pr.base);
  emit({ pr_url: observed.is_draft ? markPrReady(pr, source).url : observed.url });
}

try {
  flipReady();
} catch (error) {
  refuse(`flip-ready: ${error instanceof Error ? error.message : String(error)}`);
}
