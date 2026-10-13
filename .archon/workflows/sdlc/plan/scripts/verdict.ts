/**
 * Derive the plan's readiness from the planner's open questions.
 *
 * The planner declares one fact, the calls only a person can make. A caller's
 * `when:` routes on a boolean and cannot read a list, so `ready` is derived here,
 * where it cannot disagree with the list it stands for.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_OPEN_QUESTIONS / INPUTS_SUMMARY / INPUTS_REPORT: the plan node's certified output.
 */

import { emit, text } from '../../.shared/io.ts';

const openQuestions = JSON.parse(text(process.env.INPUTS_OPEN_QUESTIONS)) as string[];
emit({
  ready: openQuestions.length === 0,
  open_questions: openQuestions,
  summary: text(process.env.INPUTS_SUMMARY),
  report: JSON.parse(text(process.env.INPUTS_REPORT)) as unknown,
});
