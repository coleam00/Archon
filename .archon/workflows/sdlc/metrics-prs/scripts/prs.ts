/**
 * Metric records for the pull requests the build queue opened: opened, merged,
 * abandoned and the merge rate, each attributed to the build-queue runs that built it.
 * Pull requests a round only continued are reported in `skipped`.
 */

import { factoryPrRuns, factoryPrs, prMetricRecords, readPrFacts } from '../../.shared/factory-prs.ts';
import { emit, refuse } from '../../.shared/io.ts';
import { stateDocuments } from '../../.shared/state.ts';
import { read } from '../../.shared/workitem.ts';

try {
  const items = stateDocuments('work/').flatMap(stored => read(stored.name, stored)?.doc ?? []);
  const runsByUrl = factoryPrRuns(items);
  const { factory, skipped } = factoryPrs(readPrFacts(runsByUrl.keys()));
  emit({ metrics: prMetricRecords(factory, runsByUrl), skipped });
} catch (error) {
  refuse(`prs: ${error instanceof Error ? error.message : String(error)}`);
}
