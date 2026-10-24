/** Proceed or stop. Bound inputs: INPUTS_GATE, INPUTS_ANSWER (`null` when ungated). */
import { proceed } from '../../.shared/conductor.ts';
import { emit, json, run, text } from '../../.shared/io.ts';

run('god-mode go', () => {
  emit(
    proceed(
      text(process.env.INPUTS_GATE) === 'true',
      json(process.env.INPUTS_ANSWER) as { decision?: string; text?: string } | null,
    ),
  );
});
