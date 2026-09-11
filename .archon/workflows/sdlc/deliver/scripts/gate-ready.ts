/**
 * Deterministic readiness join: certifies the review verdict before validate and
 * flip spend.
 *
 * Two actions arrive through `with:` bindings, no latch files: the initial review's,
 * and the correction loop's final one — null when the loop was skipped. Both are
 * enum values the engine certified on the node that produced them, so this reads
 * them as facts and decides.
 *
 * The correction loop completes for either `none` or `replan`; only `none` is ready.
 * A replan fails here with the draft PR and the canonical report intact, which is why
 * the loop's own completion cannot be the gate.
 */

import { refuse, report, text } from '../../.shared/io.ts';

const reviewAction = text(process.env.INPUTS_REVIEW_ACTION);
const correctionAction = text(process.env.INPUTS_CORRECTION_ACTION) || 'null';

if (reviewAction === 'none' || (reviewAction === 'correct' && correctionAction === 'none')) {
  report('{"ready":"true"}');
} else if (reviewAction === 'replan' || correctionAction === 'replan') {
  refuse(
    'replan required: the review proved that the requested outcome cannot be ' +
      'completed inside the accepted work order. The pull request remains draft; ' +
      'see the canonical review report and discovery artifacts.'
  );
} else {
  refuse(
    'not ready: no validated ready verdict reached the delivery gate -- see the ' +
      'earliest failed or skipped node, the review report in the run artifacts, ' +
      'and the canonical PR comment.'
  );
}
