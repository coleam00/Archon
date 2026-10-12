/** Route non-introduced late CI red to an explicit operator action. */

import { emit, trimmed } from '../../.shared/io.ts';
import { passesRed } from '../../.shared/verdict.ts';

const redCause = trimmed(process.env.INPUTS_RED_CAUSE);
emit({ attention: passesRed(redCause), red_cause: redCause });
