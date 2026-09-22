import { emit, text } from '../../.shared/io.ts';

// Each branch is certified by its producing node's schema. Exactly one runs.
const comparison: unknown = JSON.parse(text(process.env.INPUTS_COMPARISON));
const validation: unknown = JSON.parse(text(process.env.INPUTS_VALIDATION));
if ((comparison === null) === (validation === null)) {
  throw new Error('Validation requires exactly one executed path.');
}
if (comparison !== null) {
  emit(comparison);
} else if (typeof validation === 'object' && validation !== null) {
  emit({ ...validation, evidence: null });
}
