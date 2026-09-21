/**
 * Carry the late-CI round's two facts out of its loop as one value: the recheck's
 * action and the fix's declared red cause. Both were certified where they were
 * produced; this only puts them side by side for the loop's `until` and the route
 * after it.
 */

import { emit, text, trimmed } from '../../.shared/io.ts';

emit({
  action: text(process.env.INPUTS_ACTION),
  red_cause: trimmed(process.env.INPUTS_RED_CAUSE),
});
