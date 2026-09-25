import { emit, text } from '../../.shared/io.ts';

// Each producer is certified by its node's schema. The comparison path and the
// ordinary path are exclusive; on the ordinary path, `run` is null only when its
// timeout stopped the gate, and `classify` ran exactly when `run` reported red.
const comparison: unknown = JSON.parse(text(process.env.INPUTS_COMPARISON));
const run = JSON.parse(text(process.env.INPUTS_RUN)) as {
  status: 'green' | 'red' | 'incomplete';
  summary: string;
} | null;
const classification = JSON.parse(text(process.env.INPUTS_CLASSIFICATION)) as {
  red_cause: 'introduced' | 'inherited' | 'environment';
  summary: string;
} | null;

if (comparison !== null) {
  if (run !== null || classification !== null) {
    throw new Error('Validation requires exactly one executed path.');
  }
  emit(comparison);
} else if (run === null) {
  emit({
    green: false,
    red_cause: 'incomplete',
    summary:
      "The project gate didn't finish: the check runner's time limit stopped it. " +
      'validation.md records which checks ran and which never did.',
    evidence: null,
  });
} else if (run.status === 'red') {
  if (classification === null) throw new Error('A red gate reached the result unclassified.');
  emit({
    green: false,
    red_cause: classification.red_cause,
    summary: classification.summary,
    evidence: null,
  });
} else {
  emit({
    green: run.status === 'green',
    red_cause: run.status === 'green' ? '' : 'incomplete',
    summary: run.summary,
    evidence: null,
  });
}
