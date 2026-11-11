/**
 * Metric records for the pull requests the build queue opened: opened, merged,
 * abandoned and the merge rate, and for each merged one the review rounds it took to
 * reach Ready, each attributed to the build-queue runs that built it; and for each issue
 * the queue worked, whether it was built and merged, its lead time, rounds and asks, in
 * total and per route. Pull requests a
 * round only continued, and merged ones whose rounds cannot be counted, are reported in
 * `skipped`; the metrics no record carries yet are reported in `not_available`.
 * Merged pull requests merged at or after `lines_since` also record the test and
 * production lines they added; without it, none do.
 *
 * One run emits only the pull requests and issues that changed from `since` up to
 * `until`. The engine keeps the latest record per metric and subject, so the rest still
 * stand, and a script node's output is capped: every record of a long history does not
 * fit in one.
 */

import { dirname, join } from 'node:path';
import { inWindow, issueMetricRecords } from '../../.shared/factory-issues.ts';
import { factoryPrRuns, factoryPrs, prMetricRecords, readPrFacts, sinceTime } from '../../.shared/factory-prs.ts';
import { artifactsDir, emit, refuse, trimmed } from '../../.shared/io.ts';
import { lineRecords, readPrFiles } from '../../.shared/pr-lines.ts';
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

const since = trimmed(process.env.INPUTS_SINCE) || '7d';
const until = trimmed(process.env.INPUTS_UNTIL);
const linesSince = trimmed(process.env.INPUTS_LINES_SINCE);

try {
  const items = stateDocuments('work/').flatMap(stored => read(stored.name, stored)?.doc ?? []);
  const runsByUrl = factoryPrRuns(items);
  const window = { from: sinceTime(since), until: until === '' ? Infinity : sinceTime(until) };
  const changed = (...times: (string | null)[]): boolean => times.some(time => time !== null && inWindow(time, window));
  const prs = factoryPrs(readPrFacts(runsByUrl.keys()));
  const factory = prs.factory.filter(pr => changed(pr.createdAt, pr.mergedAt, pr.closedAt));
  // The backfill for rounds recorded without their verdicts: every run of a project
  // keeps its artifacts beside this run's, under its run id, until they are cleaned up.
  // Not the round's recorded `artifacts`: a round recorded at a release has none.
  const runs = dirname(artifactsDir());
  const backfill = (runId: string) => backfillRunReviews(join(runs, runId));
  const reviews = reviewRoundRecords(factory, runsByUrl, prBuildRounds(items), droppedRoundPrs(items), backfill);
  // One pr.files read per pull request, so only the ones merged in the window are read.
  const linesFrom = linesSince === '' ? Infinity : sinceTime(linesSince);
  const merged = prs.factory.filter(pr => pr.state === 'MERGED' && Date.parse(pr.mergedAt ?? '') >= linesFrom);
  const lines = lineRecords(merged, runsByUrl, readPrFiles);
  emit({
    metrics: [...prMetricRecords(factory, runsByUrl), ...reviews.metrics, ...issueMetricRecords(items, window), ...lines.metrics],
    skipped: prs.skipped,
    review_rounds_skipped: reviews.skipped,
    review_rounds_distribution: reviews.distribution,
    lines_skipped: lines.skipped,
    not_available: NOT_AVAILABLE,
  });
} catch (error) {
  refuse(`prs: ${error instanceof Error ? error.message : String(error)}`);
}
