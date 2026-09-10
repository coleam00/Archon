/** Route non-introduced late CI red to an explicit operator action. */

import { emit, refuse, trimmed } from '../../.shared/io.ts';
import { invalidRedCauseMessage, parseDeclaredRedCause, passesRed } from '../../.shared/verdict.ts';

const raw = trimmed(process.env.INPUTS_RED_CAUSE);
const redCause = parseDeclaredRedCause(raw);

if (redCause === undefined) {
  refuse(invalidRedCauseMessage(raw));
} else {
  emit({ attention: passesRed(redCause), red_cause: redCause });
}
