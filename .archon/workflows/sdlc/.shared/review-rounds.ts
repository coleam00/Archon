/**
 * How many review rounds a merged factory pull request took to reach Ready, from the
 * verdicts its delivery rounds published.
 *
 * A review round is one verdict a delivery round's review published on the pull
 * request: the typed `review-report` output of the deliver loop's `review` node. The
 * build queue records a run's verdicts on its build round (`reviews`) when it records
 * the round, from the run's own typed outputs. A pull request's rounds are the
 * verdicts of every build round that carried it, oldest first.
 *
 * Rounds to Ready counts up to the verdict from which every later verdict is ready: a
 * Ready review that a later review overturned did not end the review. Only merged pull
 * requests are measured, since an open one can take another round and a record cannot
 * be withdrawn. A merged pull request whose verdicts cannot all be read is skipped with
 * its reason, never counted short.
 */

import { type BuildRound, KEPT_ROUNDS, type ReviewVerdict } from './build.ts';
import { type PrFacts, prRuns } from './factory-prs.ts';
import { outputsOf, outputsOfRuns, type RunOutputs } from './outputs.ts';
import type { WorkItem } from './workitem.ts';

/**
 * The deliver loop's published review verdicts, as a build-queue run names their typed
 * outputs: each review include's id joined to archon-review's `publish` node. A
 * conformance test derives this set from the archon-deliver and archon-review YAML.
 */
export const REVIEW_NODES: ReadonlySet<string> = new Set(['review__publish']);
const REVIEW_TYPE = 'review-report';
/** The share of pull requests needing this many rounds or more is reported. */
const MANY_ROUNDS = 5;

export type RunReviews =
  | { readonly ok: true; readonly verdicts: readonly ReviewVerdict[] }
  | { readonly ok: false; readonly problem: string };

export interface ReviewRoundRecord {
  readonly name: 'sdlc.review_rounds' | 'sdlc.review_one_round' | 'sdlc.review_five_plus_rounds';
  readonly kind: 'score';
  readonly unit: 'rounds' | 'ratio';
  readonly value: number;
  readonly subject: string;
  readonly at: string;
  readonly runs: readonly string[];
}

/** The review verdicts a run's delivery rounds published, from what was read of its typed outputs. */
function reviewsFrom(runId: string, read: RunOutputs<{ ready?: unknown }>): RunReviews {
  if (read.state !== 'read') return { ok: false, problem: read.problem };
  // An unreadable record might be one of the verdicts, so none are trusted.
  const unread = read.problems[0];
  if (unread !== undefined) return { ok: false, problem: unread };
  const verdicts: ReviewVerdict[] = [];
  for (const output of read.outputs) {
    if (!REVIEW_NODES.has(output.nodeId)) continue;
    const ready = output.value?.ready;
    if (typeof ready !== 'boolean') {
      return { ok: false, problem: `the ${output.nodeId} output of run ${runId} does not record a review verdict` };
    }
    verdicts.push({ ready, at: output.producedAt });
  }
  return { ok: true, verdicts };
}

/** The review verdicts this run's delivery rounds published. */
export function runReviews(runId: string | undefined): RunReviews {
  return reviewsFrom(runId ?? '', outputsOf(runId, REVIEW_TYPE));
}

/**
 * Backfill for build rounds recorded before rounds carried their verdicts: each run's
 * verdicts, in one read. Run artifacts do not last, so a run whose artifacts are gone
 * cannot be counted.
 */
export function backfillRunReviews(runIds: readonly string[]): Map<string, RunReviews> {
  const reviews = new Map<string, RunReviews>();
  for (const [runId, read] of outputsOfRuns<{ ready?: unknown }>(runIds, REVIEW_TYPE)) {
    reviews.set(runId, reviewsFrom(runId, read));
  }
  return reviews;
}

/** The 1-based round from which every verdict is ready, or null when the latest is not. */
export function roundsToReady(verdicts: readonly ReviewVerdict[]): number | null {
  const ordered = [...verdicts].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (ordered.at(-1)?.ready !== true) return null;
  return ordered.map(verdict => verdict.ready).lastIndexOf(false) + 2;
}

/** Every pull request a build round recorded, with the rounds that carry it. */
export function prBuildRounds(items: readonly WorkItem[]): Map<string, BuildRound[]> {
  const rounds = new Map<string, BuildRound[]>();
  for (const item of items) {
    for (const round of item.facts.build?.rounds ?? []) {
      if (round.pr_url !== '') rounds.set(round.pr_url, [...(rounds.get(round.pr_url) ?? []), round]);
    }
  }
  return rounds;
}

/**
 * The pull requests whose early build rounds the work item may have dropped: an item
 * keeps only its latest rounds, so when it is at that cap any pull request its rounds
 * carry may have had older rounds.
 */
export function droppedRoundPrs(items: readonly WorkItem[]): Set<string> {
  const urls = new Set<string>();
  for (const item of items) {
    const rounds = item.facts.build?.rounds ?? [];
    if (rounds.length < KEPT_ROUNDS) continue;
    for (const round of rounds) if (round.pr_url !== '') urls.add(round.pr_url);
  }
  return urls;
}

/** The pull request's rounds to Ready, or why they cannot be counted. */
function prRounds(
  url: string,
  rounds: readonly BuildRound[],
  dropped: ReadonlySet<string>,
  backfilled: ReadonlyMap<string, RunReviews>
): { readonly rounds: number } | { readonly reason: string } {
  if (dropped.has(url)) return { reason: 'its work item dropped its oldest build rounds' };
  const verdicts: ReviewVerdict[] = [];
  for (const round of rounds) {
    const read: RunReviews =
      round.reviews !== undefined
        ? { ok: true, verdicts: round.reviews }
        : (backfilled.get(round.run_id) ?? { ok: false, problem: `the verdicts of run ${round.run_id} were not read` });
    if (!read.ok) return { reason: read.problem };
    verdicts.push(...read.verdicts);
  }
  const count = roundsToReady(verdicts);
  return count === null ? { reason: 'it merged without a Ready review on record' } : { rounds: count };
}

/**
 * Each merged pull request's rounds to Ready, with whether it was ready after one round
 * and whether it needed five or more, attributed like the PR outcome records. Pull
 * requests whose rounds cannot be counted are skipped with the reason. `backfill` reads,
 * in one call, the verdicts of the runs whose rounds were recorded without them.
 */
export function reviewRoundRecords(
  prs: readonly PrFacts[],
  runsByUrl: ReadonlyMap<string, readonly string[]>,
  roundsByUrl: ReadonlyMap<string, readonly BuildRound[]>,
  dropped: ReadonlySet<string>,
  backfill: (runIds: readonly string[]) => ReadonlyMap<string, RunReviews>
): { metrics: ReviewRoundRecord[]; skipped: { url: string; reason: string }[]; distribution: Record<string, number> } {
  const counted = prs.filter(pr => pr.state === 'MERGED' && !dropped.has(pr.url));
  const unrecorded = counted.flatMap(pr => roundsByUrl.get(pr.url) ?? []).filter(round => round.reviews === undefined);
  const backfilled = backfill([...new Set(unrecorded.map(round => round.run_id))]);
  const metrics: ReviewRoundRecord[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const distribution: Record<string, number> = {};
  for (const pr of prs) {
    if (pr.state !== 'MERGED') continue;
    if (pr.mergedAt === null) throw new Error(`the forge reported ${pr.url} merged without a time`);
    const runs = prRuns(runsByUrl, pr.url);
    const rounded = prRounds(pr.url, roundsByUrl.get(pr.url) ?? [], dropped, backfilled);
    if ('reason' in rounded) {
      skipped.push({ url: pr.url, reason: rounded.reason });
      continue;
    }
    const { rounds } = rounded;
    distribution[String(rounds)] = (distribution[String(rounds)] ?? 0) + 1;
    const base = { kind: 'score', subject: pr.url, at: pr.mergedAt, runs } as const;
    metrics.push(
      { ...base, name: 'sdlc.review_rounds', unit: 'rounds', value: rounds },
      { ...base, name: 'sdlc.review_one_round', unit: 'ratio', value: rounds === 1 ? 1 : 0 },
      { ...base, name: 'sdlc.review_five_plus_rounds', unit: 'ratio', value: rounds >= MANY_ROUNDS ? 1 : 0 }
    );
  }
  return { metrics, skipped, distribution };
}
