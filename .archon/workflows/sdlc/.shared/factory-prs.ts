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

import { createHash } from 'node:crypto';
import { BUILD_BRANCH_PREFIX } from './build.ts';
import { forge, state, type ForgeOperations } from 'archon:script';
import { sameRepo } from './identity.ts';
import { resolvePrUrl } from './pr.ts';
import type { WorkItem } from './workitem.ts';

/** The engine accepts at most this many run ids on one record. */
export const MAX_RUNS = 20;

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
export function prFacts(url: string, view: ForgeOperations['pr.view']['result']): PrFacts {
  if (view === null) throw new Error(`forge pr.view reported no pull request for ${url}`);
  const { pr, timestamps: times } = view;
  if (times === undefined) {
    throw new Error(
      `forge pr.view reported no timestamps for ${url}; PR metrics need a forge plugin whose pr.view reports them`
    );
  }
  const createdAt = times.created_at;
  if (createdAt === null) throw new Error(`forge pr.view reported no creation time for ${url}`);
  return {
    url,
    state: pr.state === 'open' ? 'OPEN' : pr.state === 'merged' ? 'MERGED' : 'CLOSED',
    createdAt,
    mergedAt: times.merged_at,
    closedAt: times.closed_at,
    headRefName: pr.head,
    isCrossRepository: pr.head_repo === null || !sameRepo(pr.head_repo, pr.repo),
  };
}

/**
 * A merged pull request's facts never change, so a run keeps them: one state document
 * per recorded URL, holding the facts. The next run reads every kept document in one
 * call and asks the forge only about the pull requests that can still change: open
 * ones, closed ones (which can reopen), and merged ones no run has kept yet. The cost
 * of a run then grows with those, not with every pull request ever recorded.
 */
const SETTLED_PREFIX = 'pr-facts/';

const settledName = (url: string): string => `${SETTLED_PREFIX}${createHash('sha256').update(url).digest('hex')}`;

/** The facts a run kept, or undefined for a document that is not a merged pull request's facts. */
function keptFacts(value: unknown): PrFacts | undefined {
  const facts = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  if (
    facts?.state !== 'MERGED' ||
    typeof facts.url !== 'string' ||
    typeof facts.createdAt !== 'string' ||
    typeof facts.mergedAt !== 'string' ||
    (facts.closedAt !== null && typeof facts.closedAt !== 'string') ||
    typeof facts.headRefName !== 'string' ||
    typeof facts.isCrossRepository !== 'boolean'
  ) {
    return undefined;
  }
  return {
    url: facts.url,
    state: 'MERGED',
    createdAt: facts.createdAt,
    mergedAt: facts.mergedAt,
    closedAt: facts.closedAt,
    headRefName: facts.headRefName,
    isCrossRepository: facts.isCrossRepository,
  };
}

/**
 * Keep a merged pull request's facts. The metrics are already right without the
 * document, so a failed write is noted and the run goes on, and the next run reads the
 * pull request again. A refused write needs no note: the store refuses one only when
 * another run moved the document first, and that run kept the same facts.
 */
function keepFacts(name: string, facts: PrFacts, revision: number): void {
  try {
    state.put(name, facts, { ifRevision: revision });
  } catch (error) {
    console.error(`PR metrics could not keep the facts of ${facts.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Read each pull request by number, so no list limit can drop an old one, except a
 * merged one an earlier run kept. A recorded URL the forge says is not a pull request
 * URL is noted and left out; a forge that cannot resolve one fails the read, so the
 * cohort is never silently short.
 */
export function readPrFacts(urls: Iterable<string>): PrFacts[] {
  const stored = new Map(state.listValues(SETTLED_PREFIX).map(document => [document.name, document]));
  const facts: PrFacts[] = [];
  for (const url of urls) {
    const name = settledName(url);
    const kept = keptFacts(stored.get(name)?.value);
    if (kept?.url === url) {
      facts.push(kept);
      continue;
    }
    const ref = resolvePrUrl(url);
    if (ref === undefined) {
      console.error(`PR metrics skip a round's URL: "${url}" is not a pull request URL`);
      continue;
    }
    const read = prFacts(url, forge('pr.view', { selector: { kind: 'number', ref } }));
    facts.push(read);
    // A document that is not valid facts is replaced, at its revision, rather than read past every run.
    if (read.state === 'MERGED' && read.mergedAt !== null) keepFacts(name, read, stored.get(name)?.revision ?? 0);
  }
  return facts;
}

/** The time a window bound such as `since` names: an ISO date or time, or `<n>d` back from now. */
export function sinceTime(since: string): number {
  const days = /^(\d+)d$/.exec(since)?.[1];
  const from = days === undefined ? Date.parse(since) : Date.now() - Number(days) * 86_400_000;
  if (Number.isNaN(from)) throw new Error(`a window bound must be an ISO date or time, or a number of days such as 7d; received ${JSON.stringify(since)}`);
  return from;
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
