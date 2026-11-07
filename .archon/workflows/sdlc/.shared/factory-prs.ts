/**
 * The pull requests the build queue opened, and the metric records their outcomes make.
 *
 * A work item's build rounds record each round's run and the pull request it ended
 * with. A round can also end on a pull request it only continued, such as a
 * contributor's, so a factory pull request is one `isQueueBuilt` accepts: a `build/`
 * branch in the repository itself. The rest are reported as skipped.
 *
 * Each record names its pull request as the subject and the build-queue runs that built
 * it as `runs`, so the engine places it in the cohort of those runs, not of the day the
 * metric ran. Records carry no window and no state: the engine keeps the latest record
 * per name and subject, so a re-run replaces rather than adds.
 */

import { BUILD_BRANCH_PREFIX } from './build.ts';
import { invokeForge, parsePrRecord, type QualifiedPr, record, sameRepo } from './forge.ts';
import { note } from './io.ts';
import { prFromUrl } from './merge.ts';
import type { WorkItem } from './workitem.ts';

/** The engine accepts at most this many run ids on one record. */
const MAX_RUNS = 20;

/** One pull request's facts as the forge's `pr.view` reports them. */
export interface PrFacts {
  readonly url: string;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly headRefName: string;
  readonly isCrossRepository: boolean;
}

/** A record in the engine's metric shape, as these metrics fill it. */
export interface PrMetricRecord {
  readonly name: 'sdlc.prs_opened' | 'sdlc.prs_merged' | 'sdlc.prs_abandoned' | 'sdlc.pr_merge_rate';
  readonly kind: 'count' | 'score';
  readonly unit: 'prs' | 'ratio';
  readonly value: number;
  readonly subject: string;
  readonly at: string;
  readonly runs: readonly string[];
}

/** A pull request's build runs as a record's `runs`: the first the engine accepts, refused when none. */
export function prRuns(runsByUrl: ReadonlyMap<string, readonly string[]>, url: string): string[] {
  const runs = (runsByUrl.get(url) ?? []).slice(0, MAX_RUNS);
  if (runs.length === 0) throw new Error(`no build round names ${url}`);
  return runs;
}

/** Every pull request a build round recorded, with the runs of the rounds that carry it, oldest first. */
export function factoryPrRuns(items: readonly WorkItem[]): Map<string, string[]> {
  const runs = new Map<string, string[]>();
  for (const item of items) {
    for (const round of item.facts.build?.rounds ?? []) {
      if (round.pr_url === '') continue;
      const ids = runs.get(round.pr_url) ?? [];
      if (!ids.includes(round.run_id)) ids.push(round.run_id);
      runs.set(round.pr_url, ids);
    }
  }
  return runs;
}

/**
 * The facts of the pull request at `url` from its `pr.view` answer. `timestamps` is
 * optional in the forge contract because a plugin that predates it omits it, so a
 * view without it refuses rather than counting the pull request with no times.
 */
export function prFacts(url: string, view: Record<string, unknown> | null): PrFacts {
  if (view === null) throw new Error(`forge pr.view reported no pull request for ${url}`);
  const pr = parsePrRecord(view.pr);
  const times = record(view.timestamps);
  if (times === undefined) {
    throw new Error(
      `forge pr.view reported no timestamps for ${url}; PR metrics need a forge plugin whose pr.view reports them`
    );
  }
  const time = (field: string): string | null => (typeof times[field] === 'string' ? (times[field] as string) : null);
  const createdAt = time('created_at');
  if (createdAt === null) throw new Error(`forge pr.view reported no creation time for ${url}`);
  return {
    url,
    state: pr.state === 'open' ? 'OPEN' : pr.state === 'merged' ? 'MERGED' : 'CLOSED',
    createdAt,
    mergedAt: time('merged_at'),
    closedAt: time('closed_at'),
    headRefName: pr.head,
    isCrossRepository: pr.head_repo === null || !sameRepo(pr.head_repo, pr.repo),
  };
}

/**
 * Read each pull request by number, so no list limit can drop an old one. A recorded
 * URL that is not a pull request URL is noted and left out.
 */
export function readPrFacts(urls: Iterable<string>): PrFacts[] {
  const facts: PrFacts[] = [];
  for (const url of urls) {
    let ref: QualifiedPr;
    try {
      ref = prFromUrl(url);
    } catch (error) {
      note(`PR metrics skip a round's URL: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    facts.push(prFacts(url, invokeForge('pr.view', { selector: { kind: 'number', ref } })));
  }
  return facts;
}

/** A pull request from a round's branch: a `build/` branch in the repository itself. */
function isQueueBuilt(pr: PrFacts): boolean {
  return !pr.isCrossRepository && pr.headRefName.startsWith(BUILD_BRANCH_PREFIX);
}

/** The pull requests the queue opened, and the URLs of the ones a round only continued. */
export function factoryPrs(prs: readonly PrFacts[]): { factory: PrFacts[]; skipped: string[] } {
  return {
    factory: prs.filter(pr => isQueueBuilt(pr)),
    skipped: prs.filter(pr => !isQueueBuilt(pr)).map(pr => pr.url),
  };
}

type Outcome = Pick<PrMetricRecord, 'name' | 'kind' | 'unit' | 'value' | 'at'>;

const count = (name: PrMetricRecord['name'], value: number, at: string): Outcome => ({ name, kind: 'count', unit: 'prs', value, at });

/**
 * Every factory pull request counts as opened; a merged one as merged. Every one also
 * records whether it is abandoned, closed without merging: 1 at its close, else 0, so a
 * pull request reopened after a run counted it abandoned replaces that record. A resolved
 * one also scores 1 or 0 on the merge rate, at its resolution time; an open one has no
 * rate yet.
 */
function outcomes(pr: PrFacts): Outcome[] {
  const opened = count('sdlc.prs_opened', 1, pr.createdAt);
  if (pr.state === 'OPEN') return [opened, count('sdlc.prs_abandoned', 0, pr.createdAt)];
  const merged = pr.state === 'MERGED';
  const resolved = merged ? pr.mergedAt : pr.closedAt;
  if (resolved === null) throw new Error(`the forge reported ${pr.url} ${pr.state.toLowerCase()} without a time`);
  const rate: Outcome = { name: 'sdlc.pr_merge_rate', kind: 'score', unit: 'ratio', value: merged ? 1 : 0, at: resolved };
  return merged
    ? [opened, count('sdlc.prs_merged', 1, resolved), count('sdlc.prs_abandoned', 0, resolved), rate]
    : [opened, count('sdlc.prs_abandoned', 1, resolved), rate];
}

/** Each factory pull request's outcome records, with the pull request as subject and its build runs. */
export function prMetricRecords(prs: readonly PrFacts[], runsByUrl: ReadonlyMap<string, readonly string[]>): PrMetricRecord[] {
  return prs.flatMap(pr => {
    const runs = prRuns(runsByUrl, pr.url);
    return outcomes(pr).map(outcome => ({ ...outcome, subject: pr.url, runs }));
  });
}
