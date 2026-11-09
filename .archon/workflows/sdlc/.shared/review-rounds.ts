/**
 * How many review rounds a merged factory pull request took to reach Ready, from the
 * verdicts its delivery rounds published.
 *
 * A review round is one verdict a delivery round's review published on the pull
 * request: the typed `review-report` output of the deliver loop's `review` node. The
 * build queue records a run's verdicts on its build round (`reviews`) when it records
 * the round, from the run's own typed-artifact listing. A pull request's rounds are the
 * verdicts of every build round that carried it, oldest first.
 *
 * Rounds to Ready counts up to the verdict from which every later verdict is ready: a
 * Ready review that a later review overturned did not end the review. Only merged pull
 * requests are measured, since an open one can take another round and a record cannot
 * be withdrawn. A merged pull request whose verdicts cannot all be read is skipped with
 * its reason, never counted short.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BuildRound, KEPT_ROUNDS, type ReviewVerdict } from './build.ts';
import { type PrFacts, prRuns } from './factory-prs.ts';
import { record } from './forge.ts';
import { readTyped } from './typed.ts';
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

/** The review verdicts this run's delivery rounds published, from the engine's typed-artifact listing. */
export function runReviews(listingFile: string | undefined, artifacts: string): RunReviews {
  const read = readTyped<{ ready?: unknown }>(listingFile, artifacts, REVIEW_TYPE);
  if (read.listingProblem !== undefined) return { ok: false, problem: read.listingProblem };
  // An unreadable record might be one of the verdicts, so none are trusted.
  const unread = read.problems[0];
  if (unread !== undefined) return { ok: false, problem: unread };
  const verdicts: ReviewVerdict[] = [];
  for (const [index, entry] of (read.entries ?? []).entries()) {
    if (!REVIEW_NODES.has(entry.nodeId ?? '')) continue;
    const ready = read.values[index]?.ready;
    if (typeof ready !== 'boolean' || entry.producedAt === undefined) {
      return { ok: false, problem: `${entry.path} does not record a review verdict and its time` };
    }
    verdicts.push({ ready, at: entry.producedAt });
  }
  return { ok: true, verdicts };
}

/**
 * Backfill for build rounds recorded before rounds carried their verdicts: read them
 * from the run's typed-output sidecars (`nodes/<id>.meta.json`). Run artifacts do not
 * last, so a run whose artifacts are gone cannot be counted.
 */
export function backfillRunReviews(runDir: string): RunReviews {
  if (!existsSync(runDir)) return { ok: false, problem: `the artifacts of ${runDir} are gone` };
  const nodes = join(runDir, 'nodes');
  // A run that ended before any node produced typed output published no review.
  if (!existsSync(nodes)) return { ok: true, verdicts: [] };
  const verdicts: ReviewVerdict[] = [];
  try {
    for (const name of readdirSync(nodes).filter(file => file.endsWith('.meta.json'))) {
      const meta = record(JSON.parse(readFileSync(join(nodes, name), 'utf8')));
      if (meta?.outputType !== REVIEW_TYPE || !REVIEW_NODES.has(String(meta.nodeId))) continue;
      const verdict = typeof meta.path === 'string' ? record(JSON.parse(readFileSync(join(runDir, meta.path), 'utf8'))) : undefined;
      if (typeof meta.producedAt !== 'string' || typeof verdict?.ready !== 'boolean') {
        throw new Error(`${name} does not record a review verdict`);
      }
      verdicts.push({ ready: verdict.ready, at: meta.producedAt });
    }
  } catch (error) {
    return { ok: false, problem: `${runDir}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, verdicts };
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
  backfill: (runId: string) => RunReviews
): { readonly rounds: number } | { readonly reason: string } {
  if (dropped.has(url)) return { reason: 'its work item dropped its oldest build rounds' };
  const verdicts: ReviewVerdict[] = [];
  for (const round of rounds) {
    const read: RunReviews = round.reviews === undefined ? backfill(round.run_id) : { ok: true, verdicts: round.reviews };
    if (!read.ok) return { reason: read.problem };
    verdicts.push(...read.verdicts);
  }
  const count = roundsToReady(verdicts);
  return count === null ? { reason: 'it merged without a Ready review on record' } : { rounds: count };
}

/**
 * Each merged pull request's rounds to Ready, with whether it was ready after one round
 * and whether it needed five or more, attributed like the PR outcome records. Pull
 * requests whose rounds cannot be counted are skipped with the reason.
 */
export function reviewRoundRecords(
  prs: readonly PrFacts[],
  runsByUrl: ReadonlyMap<string, readonly string[]>,
  roundsByUrl: ReadonlyMap<string, readonly BuildRound[]>,
  dropped: ReadonlySet<string>,
  backfill: (runId: string) => RunReviews
): { metrics: ReviewRoundRecord[]; skipped: { url: string; reason: string }[]; distribution: Record<string, number> } {
  const metrics: ReviewRoundRecord[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const distribution: Record<string, number> = {};
  for (const pr of prs) {
    if (pr.state !== 'MERGED') continue;
    if (pr.mergedAt === null) throw new Error(`the forge reported ${pr.url} merged without a time`);
    const runs = prRuns(runsByUrl, pr.url);
    const counted = prRounds(pr.url, roundsByUrl.get(pr.url) ?? [], dropped, backfill);
    if ('reason' in counted) {
      skipped.push({ url: pr.url, reason: counted.reason });
      continue;
    }
    const { rounds } = counted;
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
