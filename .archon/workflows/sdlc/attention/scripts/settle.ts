/**
 * Settle this pass: when the stage ran, check the `decide` agent's decision and turn
 * an `ask` into the attention item; when it did not, the previous answer already
 * decided and the entry's loop ends.
 *
 * Bound inputs: INPUTS_STAGE, the public workflow; INPUTS_ANSWERED, the `answer`
 * node's output; INPUTS_DECISION, the agent's decision, or null when the stage did
 * not run.
 */

import { type Answered, type StageDecision, settle } from '../../.shared/attention.ts';
import { emit, nullableJson, refuse, text } from '../../.shared/io.ts';

function main(): void {
  const answered = JSON.parse(text(process.env.INPUTS_ANSWERED)) as Answered;
  const decision = nullableJson(process.env.INPUTS_DECISION) as StageDecision | null;
  if (!answered.judge) {
    return emit({ done: true, outcome: answered.outcome, message: '', options: [], asked: null, brief: '' });
  }
  if (decision === null) throw new Error('the stage ran but no decision was made on its ending');
  emit(settle(text(process.env.INPUTS_STAGE), answered.outcome, decision));
}

try {
  main();
} catch (error) {
  refuse(`attention settle: ${error instanceof Error ? error.message : String(error)}`);
}
