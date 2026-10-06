/**
 * Whether the merged tree's one correction left red that needs the operator.
 *
 * The green gate (../../.shared/gate.ts) refuses introduced red, red nobody
 * explained, and an unfinished validation. After the correction those are not a
 * reason to fail the delivery: they pause it for the operator, who corrects the
 * merged tree once more. Everything the gate passes, green or red the change is not
 * shown to cause, goes on through the gate as usual.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_GREEN: the correction's verdict, canonical boolean text.
 * - INPUTS_RED_CAUSE: its declared cause, or '' when none was declared.
 */

import { emit, trimmed } from '../../.shared/io.ts';
import { passesRed } from '../../.shared/verdict.ts';

const green = trimmed(process.env.INPUTS_GREEN) === 'true';
const cause = trimmed(process.env.INPUTS_RED_CAUSE);
// The gate reads `incomplete` before the verdict, so it refuses even beside green.
emit({ attention: cause === 'incomplete' || (!green && !passesRed(cause)) });
