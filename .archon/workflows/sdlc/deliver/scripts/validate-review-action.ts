/** Validate the review verdict before it controls delivery. */

import { emit, refuse, text } from '../../.shared/io.ts';
import { invalidVerdictMessage, parseReviewVerdict } from '../../.shared/verdict.ts';

const ready = text(process.env.INPUTS_READY);
const action = text(process.env.INPUTS_ACTION);
const verdict = parseReviewVerdict(ready, action);

if (verdict === undefined) {
  refuse(invalidVerdictMessage('review verdict', ready, action));
} else {
  emit(verdict);
}
