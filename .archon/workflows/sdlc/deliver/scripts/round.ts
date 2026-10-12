/**
 * Join one correction round's verdicts into the value the loop decides on.
 *
 * CI runs in a round only once its review converged, and neither `until_bash` nor
 * the loop's output can read a skipped node. This reads CI with if_skipped bindings
 * and says whether another round is owed: the review asks for corrections, or CI is
 * red because of the change. Its output is the loop's output.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_ACTION / INPUTS_DISCOVERIES: this round's review verdict.
 * - INPUTS_STATE / INPUTS_CAUSED_BY_CHANGE / INPUTS_CI_SUMMARY: this round's CI
 *   verdict, or "null" when CI did not run.
 */

import { emit, text } from '../../.shared/io.ts';

const optional = (value: string | undefined): string | null => {
  const bound = text(value);
  return bound === 'null' ? null : bound;
};

const action = text(process.env.INPUTS_ACTION);
const state = optional(process.env.INPUTS_STATE) ?? '';
const causedByChange = optional(process.env.INPUTS_CAUSED_BY_CHANGE) === 'true';

emit({
  again: action === 'correct' || (state === 'red' && causedByChange),
  action,
  discoveries: JSON.parse(text(process.env.INPUTS_DISCOVERIES)) as unknown,
  state,
  ci_summary: optional(process.env.INPUTS_CI_SUMMARY) ?? '',
});
