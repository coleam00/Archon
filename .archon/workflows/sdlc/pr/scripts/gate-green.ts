/**
 * The green gate, as archon-pr runs it on the merged tree: see ../../.shared/gate.ts for the decision.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_GREEN: the declaring node's verdict, canonical boolean text.
 * - INPUTS_RED_CAUSE: the declared cause, or '' when none was declared.
 * - INPUTS_SUMMARY: that node's summary, which carries the evidence for the claim.
 * - INPUTS_STAGE: which gate this is, for the record a human reads later.
 */

import { greenGate } from '../../.shared/gate.ts';
import { trimmed } from '../../.shared/io.ts';

greenGate({
  green: trimmed(process.env.INPUTS_GREEN),
  cause: trimmed(process.env.INPUTS_RED_CAUSE),
  summary: trimmed(process.env.INPUTS_SUMMARY),
  stage: trimmed(process.env.INPUTS_STAGE) || 'The work',
});
