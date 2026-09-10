/** Carry a validated late-CI review verdict and its red classification out of the loop. */

import { emit, input, refuse, trimmedInput } from '../../.shared/io.ts';
import {
  invalidRedCauseMessage,
  invalidVerdictMessage,
  parseDeclaredRedCause,
  parseReviewVerdict,
} from '../../.shared/verdict.ts';

const ready = input('READY');
const action = input('ACTION');
const rawCause = trimmedInput('RED_CAUSE');

const verdict = parseReviewVerdict(ready, action);
const redCause = parseDeclaredRedCause(rawCause);

if (verdict === undefined) {
  refuse(invalidVerdictMessage('late-CI review verdict', ready, action));
} else if (redCause === undefined) {
  refuse(invalidRedCauseMessage(rawCause));
} else {
  emit({ ready: verdict.ready, action: verdict.action, red_cause: redCause });
}
