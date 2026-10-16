/**
 * Store the maintainer's answer on every record this pass asked about.
 *
 * The answer is kept as written and never interpreted here: the next pass's agent
 * reads it beside the numbered questions and decides those records, and later items
 * like them, from it. This run's claim on the asking runs is released once the run
 * ends, so the next pass picks those records up again.
 *
 * Bound inputs: INPUTS_KEYS, the outcome's asked keys; INPUTS_TEXT, the answer.
 */

import { decisionName } from '../../.shared/discoveries.ts';
import { emit, nullableJson, refuse, text } from '../../.shared/io.ts';
import { statePatch } from '../../.shared/state.ts';

try {
  const keys = nullableJson(process.env.INPUTS_KEYS);
  if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string')) {
    throw new Error('keys must be the JSON array of asked keys');
  }
  const answer = { text: text(process.env.INPUTS_TEXT), at: new Date().toISOString() };
  for (const key of keys as string[]) {
    statePatch(decisionName(key), [{ op: 'set', path: '/question/answer', value: answer }]);
  }
  emit({ answered: keys });
} catch (error) {
  refuse(`discoveries answer: ${error instanceof Error ? error.message : String(error)}`);
}
