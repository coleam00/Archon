/**
 * Act on the answer to the previous pass's attention item, before this pass is judged.
 *
 * On the first pass there is no answer: the stage ran, and its outcome is judged. A
 * `rerun` answer ran the stage again, so this pass's outcome is judged the same way.
 * A stage that failed is not judged and raises no item: the failed node fails the
 * entry's loop, and the run fails with the stage's own error.
 * `finish` and `ready` skipped the stage: the previous pass's outcome stands, and
 * `ready` first takes that pass's pull request out of draft and reads it back.
 *
 * Bound inputs: INPUTS_OUTCOME, this pass's stage outcome, empty when the stage did
 * not run; INPUTS_PREVIOUS, the previous pass's `settle` output, and INPUTS_ANSWER,
 * the answer to its item, both empty on the first pass.
 */

import { type Answered, previousAnswer } from '../../.shared/attention.ts';
import { forgeSource } from '../../.shared/forge.ts';
import { emit, refuse, text } from '../../.shared/io.ts';
import { isFailureReason, setPrDraft } from '../../.shared/pr.ts';

/**
 * A failure before a block's terminal node skips it and leaves no outcome; deliver and
 * ship still report, with reason `failed` or `pr_create_unresolved`.
 */
function judged(outcome: string, applied: string): Answered {
  const parsed = outcome.trim() === '' ? null : (JSON.parse(outcome) as unknown);
  const failed =
    parsed === null ||
    (typeof parsed === 'object' && 'reason' in parsed && isFailureReason(parsed.reason));
  return { judge: !failed, outcome: parsed, applied };
}

function main(): void {
  const outcome = text(process.env.INPUTS_OUTCOME);
  const answered = previousAnswer(text(process.env.INPUTS_PREVIOUS), text(process.env.INPUTS_ANSWER));
  if (answered === null) return emit(judged(outcome, ''));
  const { asked, choice } = answered;
  if (choice === 'rerun') return emit(judged(outcome, 'The stage ran again.'));
  if (choice === 'finish') {
    return emit({ judge: false, outcome: answered.outcome, applied: 'The outcome stands as the stage left it.' });
  }
  // settle refuses a `ready` choice without a pull request.
  if (asked.pull_request === null) throw new Error('the `ready` answer names no pull request');
  const pr = setPrDraft(asked.pull_request, false, forgeSource());
  emit({ judge: false, outcome: answered.outcome, applied: `${pr.url} is ready for review.` });
}

try {
  main();
} catch (error) {
  refuse(`attention answer: ${error instanceof Error ? error.message : String(error)}`);
}
