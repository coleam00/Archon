/**
 * The factory pull requests merged at or after `since` (an ISO time, or `<n>d` back from
 * now), with the build-queue runs that built each, for the judge to fan out over.
 */

import { factoryPrRuns, factoryPrs, prRuns, readPrFacts, sinceTime } from '../../.shared/factory-prs.ts';
import { emit, input, refuse, state } from 'archon:script';
import { requireTestValueSource } from '../../.shared/test-value.ts';
import { read } from '../../.shared/workitem.ts';

const since = input('since').trim();

try {
  const from = sinceTime(since);
  const items = state.listValues('work/').flatMap(stored => read(stored.name, stored)?.doc ?? []);
  const runsByUrl = factoryPrRuns(items);
  const prs = factoryPrs(readPrFacts(runsByUrl.keys()))
    .factory.filter(pr => pr.state === 'MERGED' && pr.mergedAt !== null && Date.parse(pr.mergedAt) >= from)
    .map(pr => ({ url: pr.url, merged_at: pr.mergedAt as string, runs: prRuns(runsByUrl, pr.url) }));
  requireTestValueSource(prs.map(pr => new URL(pr.url).host));
  emit({ prs, urls: prs.map(pr => pr.url) });
} catch (error) {
  refuse(`prs: ${error instanceof Error ? error.message : String(error)}`);
}
