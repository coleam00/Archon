/**
 * Metric records for the pull requests the build queue opened: opened, merged,
 * abandoned and the merge rate, and for each merged one the review rounds it took to
 * reach Ready, each attributed to the build-queue runs that built it. Pull requests a
 * round only continued, and merged ones whose rounds cannot be counted, are reported in
 * `skipped`; the metrics no record carries yet are reported in `not_available`.
 */

import { dirname, join } from 'node:path';
import { factoryPrRuns, factoryPrs, prMetricRecords, readPrFacts } from '../../.shared/factory-prs.ts';
import { artifactsDir, emit, refuse } from '../../.shared/io.ts';
import { backfillRunReviews, droppedRoundPrs, prBuildRounds, reviewRoundRecords } from '../../.shared/review-rounds.ts';
import { stateDocuments } from '../../.shared/state.ts';
import { read } from '../../.shared/workitem.ts';

/** The review set's metrics that no record the pack writes can count yet. */
const NOT_AVAILABLE = [
  {
    metric: 'merged pull requests later reverted, or fixed by a follow-up',
    reason:
      'no record links a merged pull request to its revert or to the change that fixed it: the merge record keeps no landed commit, the forge contract has no read that finds a revert, and a follow-up names what it fixes only in prose',
  },
  {
    metric: 'blocking findings on code the change did not modify',
    reason: 'review findings carry no typed origin yet',
  },
];

try {
  const items = stateDocuments('work/').flatMap(stored => read(stored.name, stored)?.doc ?? []);
  const runsByUrl = factoryPrRuns(items);
  const { factory, skipped } = factoryPrs(readPrFacts(runsByUrl.keys()));
  // The backfill for rounds recorded without their verdicts: every run of a project
  // keeps its artifacts beside this run's, under its run id, until they are cleaned up.
  const runs = dirname(artifactsDir());
  const backfill = (runId: string) => backfillRunReviews(join(runs, runId));
  const reviews = reviewRoundRecords(factory, runsByUrl, prBuildRounds(items), droppedRoundPrs(items), backfill);
  emit({
    metrics: [...prMetricRecords(factory, runsByUrl), ...reviews.metrics],
    skipped,
    review_rounds_skipped: reviews.skipped,
    review_rounds_distribution: reviews.distribution,
    not_available: NOT_AVAILABLE,
  });
} catch (error) {
  refuse(`prs: ${error instanceof Error ? error.message : String(error)}`);
}
