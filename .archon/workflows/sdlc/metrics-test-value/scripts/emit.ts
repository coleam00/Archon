/**
 * Map the judge's verdicts to `sdlc.tests_added` and `sdlc.tests_unprotective` per
 * pull request. Pull requests whose judge did not complete are listed in `skipped`.
 */

import { emit, refuse, text } from '../../.shared/io.ts';
import { judgeIdentity, judgeSlots, type MergedPr, testValueRecords } from '../../.shared/test-value.ts';

try {
  const prs = JSON.parse(text(process.env.INPUTS_PRS)) as MergedPr[];
  const slots = judgeSlots(JSON.parse(text(process.env.INPUTS_VERDICTS)), prs.length);
  emit(testValueRecords(prs, slots, judgeIdentity()));
} catch (error) {
  refuse(`emit: ${error instanceof Error ? error.message : String(error)}`);
}
