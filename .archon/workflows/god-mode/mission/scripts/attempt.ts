/**
 * Decide one attempt from its typed parts. Bound inputs: INPUTS_PREVIOUS (the
 * previous attempt number, empty on the first), and each body node's fields, `null`
 * when that node was skipped.
 */
import { emit, json, run, text } from '../../.shared/io.ts';
import { decideAttempt } from '../../.shared/mission.ts';

const bool = (v: unknown): boolean | null => (v === null ? null : v === true);

run('mission attempt', () => {
  const previous = json(process.env.INPUTS_PREVIOUS);
  emit(
    decideAttempt({
      previous: typeof previous === 'number' ? previous : 0,
      blocked: bool(json(process.env.INPUTS_BLOCKED)),
      blocker: text(process.env.INPUTS_BLOCKER),
      summary: text(process.env.INPUTS_SUMMARY),
      pass: bool(json(process.env.INPUTS_PASS)),
      report: text(process.env.INPUTS_REPORT),
      approve: bool(json(process.env.INPUTS_APPROVE)),
      findings: text(process.env.INPUTS_FINDINGS),
    }),
  );
});
