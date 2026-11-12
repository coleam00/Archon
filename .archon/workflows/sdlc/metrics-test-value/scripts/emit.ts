/**
 * Map the judge's verdicts to `sdlc.tests_added` and `sdlc.tests_unprotective` per
 * pull request. Pull requests whose judge did not complete are listed in `skipped`.
 */

import { emit, input, refuse } from 'archon:script';
import { judgeIdentity, judgeSlots, type MergedPr, testValueRecords } from '../../.shared/test-value.ts';

try {
  const prs = JSON.parse(input('prs')) as MergedPr[];
  emit(testValueRecords(judgeSlots(prs, JSON.parse(input('verdicts'))), judgeIdentity()));
} catch (error) {
  refuse(`emit: ${error instanceof Error ? error.message : String(error)}`);
}
