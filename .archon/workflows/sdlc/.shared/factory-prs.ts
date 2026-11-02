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

import { type QualifiedPr, record } from './forge.ts';
import { note } from './io.ts';
import { prFromUrl } from './merge.ts';
import { isQueueBuilt } from './own-prs.ts';
import { ghGraphql } from './pr.ts';
import type { WorkItem } from './workitem.ts';

/** The engine accepts at most this many run ids on one record. */
const MAX_RUNS = 20;
/** Pull requests read per GraphQL request. */
const BATCH = 50;

/** One pull request's facts as GitHub reports them. */
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

const PR_SELECTION = 'url state createdAt mergedAt closedAt headRefName isCrossRepository';
const STATES = ['OPEN', 'CLOSED', 'MERGED'] as const;

function prFacts(url: string, value: unknown): PrFacts {
  const row = record(value);
  const state = STATES.find(known => known === row?.state);
  const time = (field: string): string | null => (typeof row?.[field] === 'string' ? (row[field] as string) : null);
  const createdAt = time('createdAt');
  if (
    state === undefined ||
    createdAt === null ||
    typeof row?.headRefName !== 'string' ||
    typeof row.isCrossRepository !== 'boolean'
  ) {
    throw new Error(`GitHub reported no readable pull request for ${url}`);
  }
  return {
    url,
    state,
    createdAt,
    mergedAt: time('mergedAt'),
    closedAt: time('closedAt'),
    headRefName: row.headRefName,
    isCrossRepository: row.isCrossRepository,
  };
}

/**
 * Read each pull request by number, in batches per repository, so no list limit can drop
 * an old one. A recorded URL that is not a pull request URL is noted and left out.
 */
export function readPrFacts(urls: Iterable<string>): PrFacts[] {
  const byRepo = new Map<string, { host: string; owner: string; name: string; prs: { url: string; number: number }[] }>();
  for (const url of urls) {
    let parsed: QualifiedPr;
    try {
      parsed = prFromUrl(url);
    } catch (error) {
      note(`PR metrics skip a round's URL: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const [owner = '', name = ''] = parsed.repo.path.split('/');
    const key = `${parsed.repo.host}/${parsed.repo.path}`.toLowerCase();
    const repo = byRepo.get(key) ?? { host: parsed.repo.host, owner, name, prs: [] };
    repo.prs.push({ url, number: parsed.number });
    byRepo.set(key, repo);
  }
  const facts: PrFacts[] = [];
  for (const repo of byRepo.values()) {
    for (let start = 0; start < repo.prs.length; start += BATCH) {
      const batch = repo.prs.slice(start, start + BATCH);
      const aliases = batch.map((pr, index) => `p${String(index)}: pullRequest(number: ${String(pr.number)}) { ${PR_SELECTION} }`);
      const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases.join(' ')} } }`;
      const repository = record(ghGraphql(repo.host, query, { owner: repo.owner, name: repo.name }).repository);
      if (repository === undefined) throw new Error(`GitHub reported no repository ${repo.owner}/${repo.name}`);
      batch.forEach((pr, index) => facts.push(prFacts(pr.url, repository[`p${String(index)}`])));
    }
  }
  return facts;
}

/** The pull requests the queue opened, and the URLs of the ones a round only continued. */
export function factoryPrs(prs: readonly PrFacts[]): { factory: PrFacts[]; skipped: string[] } {
  return {
    factory: prs.filter(pr => isQueueBuilt(pr)),
    skipped: prs.filter(pr => !isQueueBuilt(pr)).map(pr => pr.url),
  };
}

/**
 * Every factory pull request counts as opened; a merged one as merged, and one closed
 * without merging as abandoned. A resolved one also scores 1 or 0 on the merge rate,
 * at its resolution time; an open one has no rate yet.
 */
export function prMetricRecords(prs: readonly PrFacts[], runsByUrl: ReadonlyMap<string, readonly string[]>): PrMetricRecord[] {
  const records: PrMetricRecord[] = [];
  for (const pr of prs) {
    const runs = (runsByUrl.get(pr.url) ?? []).slice(0, MAX_RUNS);
    if (runs.length === 0) throw new Error(`no build round names ${pr.url}`);
    const base = { subject: pr.url, runs };
    records.push({ ...base, name: 'sdlc.prs_opened', kind: 'count', unit: 'prs', value: 1, at: pr.createdAt });
    if (pr.state === 'OPEN') continue;
    const merged = pr.state === 'MERGED';
    const resolved = merged ? pr.mergedAt : pr.closedAt;
    if (resolved === null) throw new Error(`GitHub reported ${pr.url} ${pr.state.toLowerCase()} without a time`);
    records.push({ ...base, name: merged ? 'sdlc.prs_merged' : 'sdlc.prs_abandoned', kind: 'count', unit: 'prs', value: 1, at: resolved });
    records.push({ ...base, name: 'sdlc.pr_merge_rate', kind: 'score', unit: 'ratio', value: merged ? 1 : 0, at: resolved });
  }
  return records;
}
