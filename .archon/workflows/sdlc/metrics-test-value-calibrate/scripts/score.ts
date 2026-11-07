/**
 * Score the judge against the labels: `sdlc.tests_unprotective_judge_agreement` and
 * `sdlc.tests_unprotective_judge_catch_rate`, one 0/1 record per labeled test, under
 * the judge's identity. The tests the judge got wrong are listed in `disagreements`.
 */

import { emit, refuse, text } from '../../.shared/io.ts';
import { type Case, judgeIdentity, judgeSlots, scoreCalibration } from '../../.shared/test-value.ts';

try {
  // The `cases` node parsed and checked these before any judge ran.
  const cases = JSON.parse(text(process.env.INPUTS_CASES)) as Case[];
  emit(scoreCalibration(judgeSlots(cases, JSON.parse(text(process.env.INPUTS_VERDICTS))), judgeIdentity()));
} catch (error) {
  refuse(`score: ${error instanceof Error ? error.message : String(error)}`);
}
