/** Validate the review verdict before it controls delivery. */

import { emit, input, refuse } from '../../.shared/io.ts';
import { invalidVerdictMessage, parseReviewVerdict } from '../../.shared/verdict.ts';

const ready = input('READY');
const action = input('ACTION');
const verdict = parseReviewVerdict(ready, action);

if (verdict === undefined) {
  refuse(invalidVerdictMessage('review verdict', ready, action));
} else {
  emit(verdict);
}
