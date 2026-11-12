/**
 * Derive the workflow's boolean outcome from the investigator's typed verdict.
 *
 * The engine's authored outcome needs a required boolean on the returns node; the
 * investigator declares one verdict (`rooted`, `refuted` or `inconclusive`). Deriving
 * `rooted` here keeps one declaration, so the two can never disagree.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_VERDICT / INPUTS_SUMMARY / INPUTS_REPORT: the investigate node's certified output.
 */

import { emit, input } from 'archon:script';

const verdict = input('verdict');
emit({
  verdict,
  rooted: verdict === 'rooted',
  summary: input('summary'),
  report: JSON.parse(input('report')) as unknown,
});
