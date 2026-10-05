/**
 * Mark the pull request ready for review once the work is done: review converged and
 * the local gate is green for the tree. CI is waited on after this, not before: a
 * project whose CI skips draft pull requests only starts it here, and on one whose
 * CI also runs on drafts this changes nothing. confirm-ready, at the end, certifies
 * green on the final head and converts the pull request back to draft when it is not,
 * so a red pull request never stays ready.
 *
 * Before the flip it refuses a head that does not merge cleanly into its freshly
 * fetched base (`git merge-tree`, git 2.38 or later), found through the remote that
 * holds the recorded repository: a conflicting pull request is never handed to a
 * maintainer as ready. The flip targets the recorded qualified pull request through
 * the source the run selected, and reads the state back. A pull request already
 * merged needs no flip; one closed without a merge refuses.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */
import { forgeSource, parsePrRecord, type PrRecord } from '../../.shared/forge.ts';
import { git } from '../../.shared/git.ts';
import { markPrReady, viewPr } from '../../.shared/pr.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';
import { remoteRefFor } from '../../.shared/remote.ts';

function mergesCleanly(pr: PrRecord): void {
  const base = remoteRefFor(pr.repo, pr.base);
  const result = git('merge-tree', '--write-tree', '--name-only', base, 'HEAD');
  if (result.code === 1) {
    // Output: the tree id, then the conflicted paths, then a blank line and messages.
    const conflicted = result.stdout.split('\n\n')[0].split('\n').slice(1).filter(Boolean);
    throw new Error(`the head does not merge cleanly into ${base}: ${conflicted.join(', ')}`);
  }
  if (result.code !== 0) throw new Error(`mergeability could not be computed: ${result.stderr}`);
}

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
  mergesCleanly(pr);
  emit({ pr_url: observed.is_draft ? markPrReady(pr, source).url : observed.url });
}

try {
  flipReady();
} catch (error) {
  refuse(`flip-ready: ${error instanceof Error ? error.message : String(error)}`);
}
