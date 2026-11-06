/**
 * How many review rounds a merged factory pull request took to reach Ready, from the
 * verdicts its delivery rounds published.
 *
 * A review round is one verdict a delivery round's review published on the pull
 * request: the typed `review-report` output of the deliver loop's `review` node, or of
 * its `rereview` node, which reviews what simplify's reshape changed. The engine keeps
 * each such output as a typed-output sidecar in the build run's artifacts
 * (`nodes/<id>.meta.json` beside its content), and every build round on a work item
 * names the run that holds them. A pull request's rounds are the verdicts of every
 * build run that carried it, oldest first.
 *
 * Rounds to Ready counts up to the verdict from which every later verdict is ready: a
 * Ready review that a later review overturned did not end the review. Only merged pull
 * requests are measured, since an open one can take another round and a record cannot
 * be withdrawn. A merged pull request whose verdicts cannot all be read is skipped with
 * its reason, never counted short.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEPT_ROUNDS } from './build.ts';
import { type PrFacts, prRuns } from './factory-prs.ts';
import { record } from './forge.ts';
import type { WorkItem } from './workitem.ts';

/** The deliver loop's review nodes, as a build run's sidecars name them. */
const REVIEW_NODES: ReadonlySet<string> = new Set(['review__publish', 'rereview__publish']);
/** The share of pull requests needing this many rounds or more is reported. */
const MANY_ROUNDS = 5;

export interface Verdict {
  readonly at: string;
  readonly ready: boolean;
}

export type RunVerdicts =
  | { readonly ok: true; readonly verdicts: readonly Verdict[] }
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

/** The review verdicts a build run published, from its artifacts directory. */
export function readRunVerdicts(runDir: string): RunVerdicts {
  if (!existsSync(runDir)) return { ok: false, problem: `the artifacts of ${runDir} are gone` };
  const nodes = join(runDir, 'nodes');
  // A run that ended before any node produced typed output published no review.
  if (!existsSync(nodes)) return { ok: true, verdicts: [] };
  const verdicts: Verdict[] = [];
  try {
    for (const name of readdirSync(nodes).filter(file => file.endsWith('.meta.json'))) {
      const meta = record(JSON.parse(readFileSync(join(nodes, name), 'utf8')));
      if (meta?.outputType !== 'review-report' || !REVIEW_NODES.has(String(meta.nodeId))) continue;
      const verdict = typeof meta.path === 'string' ? record(JSON.parse(readFileSync(join(runDir, meta.path), 'utf8'))) : undefined;
      if (typeof meta.producedAt !== 'string' || typeof verdict?.ready !== 'boolean') {
        throw new Error(`${name} does not record a review verdict`);
      }
      verdicts.push({ at: meta.producedAt, ready: verdict.ready });
    }
  } catch (error) {
    return { ok: false, problem: `${runDir}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, verdicts };
}

/** The 1-based round from which every verdict is ready, or null when the latest is not. */
export function roundsToReady(verdicts: readonly Verdict[]): number | null {
  const ordered = [...verdicts].sort((left, right) => left.at.localeCompare(right.at));
  if (ordered.at(-1)?.ready !== true) return null;
  return ordered.map(verdict => verdict.ready).lastIndexOf(false) + 2;
}

/**
 * The pull requests whose early build rounds the work item may have dropped: an item
 * keeps only its latest rounds, so when it is at that cap and its oldest kept round
 * carries the pull request, older rounds may have carried it too.
 */
export function droppedRoundPrs(items: readonly WorkItem[]): Set<string> {
  const urls = new Set<string>();
  for (const item of items) {
    const rounds = item.facts.build?.rounds ?? [];
    const oldest = rounds[0]?.pr_url ?? '';
    if (rounds.length >= KEPT_ROUNDS && oldest !== '') urls.add(oldest);
  }
  return urls;
}

/** The pull request's rounds to Ready, or why they cannot be counted. */
function prRounds(
  url: string,
  runs: readonly string[],
  dropped: ReadonlySet<string>,
  verdictsOf: (runId: string) => RunVerdicts
): { readonly rounds: number } | { readonly reason: string } {
  if (dropped.has(url)) return { reason: 'its work item dropped its oldest build rounds' };
  const verdicts: Verdict[] = [];
  for (const runId of runs) {
    const read = verdictsOf(runId);
    if (!read.ok) return { reason: read.problem };
    verdicts.push(...read.verdicts);
  }
  const rounds = roundsToReady(verdicts);
  return rounds === null ? { reason: 'it merged without a Ready review on record' } : { rounds };
}

/**
 * Each merged pull request's rounds to Ready, with whether it was ready after one round
 * and whether it needed five or more, attributed like the PR outcome records. Pull
 * requests whose rounds cannot be counted are skipped with the reason.
 */
export function reviewRoundRecords(
  prs: readonly PrFacts[],
  runsByUrl: ReadonlyMap<string, readonly string[]>,
  dropped: ReadonlySet<string>,
  verdictsOf: (runId: string) => RunVerdicts
): { metrics: ReviewRoundRecord[]; skipped: { url: string; reason: string }[]; distribution: Record<string, number> } {
  const metrics: ReviewRoundRecord[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const distribution: Record<string, number> = {};
  for (const pr of prs) {
    if (pr.state !== 'MERGED') continue;
    if (pr.mergedAt === null) throw new Error(`the forge reported ${pr.url} merged without a time`);
    const runs = prRuns(runsByUrl, pr.url);
    const counted = prRounds(pr.url, runs, dropped, verdictsOf);
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
