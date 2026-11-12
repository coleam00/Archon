/**
 * Move the run's checkout to the head of the pull request the round continues.
 *
 * The run's checkout is cut from the default branch. A round that continues a pull
 * request and adds nothing would otherwise publish that base onto the pull request's
 * head, which git refuses as a non-fast-forward. Starting from the pull request's head
 * makes publish a fast-forward, or a no-op when the round adds nothing.
 *
 * The checkout moves only when it is clean and its commit is already on a remote, so
 * nothing local is lost.
 *
 * A fresh round stays where it is, but only when that is on the repository's current
 * default branch: an adopted checkout left at a superseded pull request's head would
 * otherwise carry its commits into the replacement pull request. It refuses instead.
 *
 * Bound inputs: INPUTS_ITEM, the item from facts, whose repository names the base;
 * INPUTS_PULL_REQUEST, the item's pull request from facts, or null;
 * INPUTS_CANDIDATE, the number facts found continuable, else empty or `null`;
 * INPUTS_CONTINUES, the number route declared the round continues, else empty or `null`;
 * INPUTS_ROUNDS, the item's earlier build rounds from facts, oldest first.
 * Route may decline the candidate, never name another pull request.
 *
 * It emits the commit the continued pull request's review last named, or null, so the
 * answer can tell whether the round changed anything since that review, and the pull
 * request the round continues: its number, or null for a fresh round. It also emits the
 * report the round's first review continues from, so a pull request reviewed in an
 * earlier run is not reviewed from the start again.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emit, input, refuse } from 'archon:script';
import type { BuildRound } from '../../.shared/build.ts';
import { type PrRecord, type QualifiedPr } from '../../.shared/identity.ts';
import { nullableJson } from '../../.shared/inputs.ts';
import { git, gitOrThrow } from '../../.shared/git.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import { publishedReview } from '../../.shared/merge.ts';
import type { ReviewStamp } from '../../.shared/review-comment.ts';
import { PUBLISHED_REPORT_FILE, REVIEWED_HEAD_FILE } from '../../.shared/review-item.ts';
import { viewPr } from '../../.shared/pr.ts';
import { fetchDefaultBranch, remoteFor } from '../../.shared/remote.ts';

/**
 * The report the round's first review continues from: the one an earlier round of this
 * item kept when it published `review`, the pull request's trusted review comment, at
 * the commit that comment names and with the report it shows. Empty, so that review
 * reads the whole change, when no kept round's artifacts on this machine hold that
 * review (another install published it, a review outside the queue replaced it, or the
 * artifacts are gone), or when the head no longer descends from that commit.
 */
function priorReport(review: ReviewStamp, head: string): string {
  if (git('merge-base', '--is-ancestor', review.reviewed, head).code !== 0) return '';
  const rounds = nullableJson(input('rounds')) as readonly BuildRound[];
  for (const round of [...rounds].reverse()) {
    if (round.artifacts === '') continue;
    const report = join(round.artifacts, PUBLISHED_REPORT_FILE);
    const recorded = join(dirname(report), REVIEWED_HEAD_FILE);
    if (!existsSync(recorded) || readFileSync(recorded, 'utf8').trim() !== review.reviewed) continue;
    if (readFileSync(report, 'utf8').trim() === review.report.trim()) return report;
    console.error(
      `build-queue checkout: run ${round.run_id} kept a review at ${review.reviewed}, but the pull request's review comment shows another report; it is not continued`
    );
  }
  return '';
}

/** A fresh round stays on the base and continues no pull request. */
function fresh(): void {
  const item = nullableJson(input('item')) as Pick<QualifiedPr, 'repo'> | null;
  if (item === null) throw new Error('facts reported no item for the round');
  const base = fetchDefaultBranch(item.repo);
  if (git('merge-base', '--is-ancestor', 'HEAD', base.sha).code !== 0)
    throw new Error(`a fresh round must start on ${base.branch}, but the checkout's HEAD is not on it`);
  emit({ head: null, reviewed: null, pull_request: null, prior_report: '' });
}

function main(): void {
  const continues = nullableJson(input('continues')) as number | null;
  const candidate = nullableJson(input('candidate')) as number | null;
  const known = nullableJson(input('pull_request')) as PrRecord | null;
  if (continues === null) {
    fresh();
    return;
  }
  if (continues !== candidate)
    throw new Error(`route continues pull request ${String(continues)}, but only ${String(candidate ?? 'none')} can be continued`);
  if (known === null || known.number !== continues)
    throw new Error(`route continues pull request ${String(continues)} but reports ${String(known?.number ?? 'none')}`);
  const pr = viewPr({ repo: known.repo, number: continues }).pr;
  if (pr.state !== 'open' || pr.head_revision === null)
    throw new Error(`${pr.url} is ${pr.state}; the round cannot continue it`);

  if (gitOrThrow('status', '--porcelain') !== '') throw new Error('the checkout has uncommitted changes');
  if (gitOrThrow('branch', '-r', '--contains', 'HEAD') === '')
    throw new Error('the checkout has commits no remote holds; it is left as it is');
  gitOrThrow('fetch', '--no-tags', remoteFor(pr.repo), `refs/heads/${pr.head}`);
  const head = gitOrThrow('rev-parse', 'FETCH_HEAD');
  if (head !== pr.head_revision)
    throw new Error(`${pr.url} reports head ${pr.head_revision}, but its branch is at ${head}`);
  const branch = gitOrThrow('branch', '--show-current');
  gitOrThrow('checkout', '-q', ...(branch === '' ? ['--detach'] : ['-B', branch]), head);
  const ref = { repo: pr.repo, number: continues };
  const review = publishedReview(ref, readMaintainers(pr.repo));
  emit({
    head,
    reviewed: review?.reviewed ?? null,
    pull_request: continues,
    prior_report: review === null ? '' : priorReport(review, head),
  });
}

try {
  main();
} catch (error) {
  refuse(`build-queue checkout: ${error instanceof Error ? error.message : String(error)}`);
}
