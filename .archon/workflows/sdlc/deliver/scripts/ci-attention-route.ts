/**
 * Route late CI red the change is not shown to have caused to an explicit
 * operator action. The cause classified after the CI fix, when there is one, is the
 * current one; otherwise the cause the first classification settled.
 */

import { emit, trimmed } from '../../.shared/io.ts';
import { passesRed } from '../../.shared/verdict.ts';

const postFix = trimmed(process.env.INPUTS_POST_FIX_CAUSE);
const redCause = postFix === '' ? trimmed(process.env.INPUTS_RED_CAUSE) : postFix;
emit({ attention: passesRed(redCause), red_cause: redCause });
