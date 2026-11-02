/**
 * Score the judge against the labels: `sdlc.tests_unprotective_judge_agreement` and
 * `sdlc.tests_unprotective_judge_catch_rate`, one 0/1 record per labeled test, under
 * the judge's identity. The tests the judge got wrong are listed in `disagreements`.
 */

import { emit, refuse, text } from '../../.shared/io.ts';
import { judgeIdentity, judgeSlots, parseCases, scoreCalibration } from '../../.shared/test-value.ts';

try {
  const cases = parseCases(JSON.parse(text(process.env.INPUTS_CASES)));
  const slots = judgeSlots(JSON.parse(text(process.env.INPUTS_VERDICTS)), cases.length);
  emit(scoreCalibration(cases, slots, judgeIdentity()));
} catch (error) {
  refuse(`score: ${error instanceof Error ? error.message : String(error)}`);
}
