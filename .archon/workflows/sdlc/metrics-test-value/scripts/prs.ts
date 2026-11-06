/**
 * The factory pull requests merged at or after `since` (an ISO time, or `<n>d` back from
 * now), with the build-queue runs that built each, for the judge to fan out over.
 */

import { factoryPrRuns, factoryPrs, prRuns, readPrFacts } from '../../.shared/factory-prs.ts';
import { emit, refuse, trimmed } from '../../.shared/io.ts';
import { stateDocuments } from '../../.shared/state.ts';
import { requireTestValueSource } from '../../.shared/test-value.ts';
import { read } from '../../.shared/workitem.ts';

const since = trimmed(process.env.INPUTS_SINCE);

try {
  const days = /^(\d+)d$/.exec(since)?.[1];
  const from = days === undefined ? Date.parse(since) : Date.now() - Number(days) * 86_400_000;
  if (Number.isNaN(from)) throw new Error(`since must be an ISO date or time, or a number of days such as 7d; received ${JSON.stringify(since)}`);
  const items = stateDocuments('work/').flatMap(stored => read(stored.name, stored)?.doc ?? []);
  const runsByUrl = factoryPrRuns(items);
  const prs = factoryPrs(readPrFacts(runsByUrl.keys()))
    .factory.filter(pr => pr.state === 'MERGED' && pr.mergedAt !== null && Date.parse(pr.mergedAt) >= from)
    .map(pr => ({ url: pr.url, merged_at: pr.mergedAt as string, runs: prRuns(runsByUrl, pr.url) }));
  requireTestValueSource(prs.map(pr => new URL(pr.url).host));
  emit({ prs, urls: prs.map(pr => pr.url) });
} catch (error) {
  refuse(`prs: ${error instanceof Error ? error.message : String(error)}`);
}
