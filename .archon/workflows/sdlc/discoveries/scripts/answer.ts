/**
 * Store the maintainer's answer on every question this pass asked.
 *
 * The answer is kept as written and never interpreted here: the next pass's agent reads
 * it beside the question, on the run's own document, and decides those refs from it.
 * This run's claim on the asking runs is released once the run ends, so the next pass
 * picks those refs up again.
 *
 * Bound inputs: INPUTS_KEYS, the outcome's asked keys; INPUTS_TEXT, the answer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRunDocument, type Queue, runName } from '../../.shared/discoveries.ts';
import { artifactsDir, emit, nullableJson, refuse, text } from '../../.shared/io.ts';
import { stateGet, statePut } from '../../.shared/state.ts';

try {
  const keys = nullableJson(process.env.INPUTS_KEYS);
  if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string')) {
    throw new Error('keys must be the JSON array of asked keys');
  }
  const answer = { text: text(process.env.INPUTS_TEXT), at: new Date().toISOString() };
  const queue = JSON.parse(readFileSync(join(artifactsDir(), 'drain', 'queue.json'), 'utf8')) as Queue;
  for (const run of queue.runs) {
    const name = runName(run.id);
    const read = stateGet(name);
    const document = parseRunDocument(name, read.value);
    if (document === null) continue;
    let changed = false;
    const questions = (document.questions ?? []).map(question => {
      if (question.answer !== null || !question.keys.some(key => (keys as string[]).includes(key))) return question;
      changed = true;
      return { ...question, answer };
    });
    // A run with no question answered here is not this pass's to write: another pass may hold it.
    if (!changed) continue;
    if (statePut(name, { ...document, questions }, read.revision) === 'conflict') {
      throw new Error(`${name} changed while this run held its claim`);
    }
  }
  emit({ answered: keys });
} catch (error) {
  refuse(`discoveries answer: ${error instanceof Error ? error.message : String(error)}`);
}
