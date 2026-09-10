/**
 * Deterministic readiness join: certifies the review verdict before validate and
 * flip spend.
 *
 * The verdicts arrive through `with:` bindings, no latch files: the initial review's,
 * and the correction loop's final one — false/null when the loop was skipped.
 *
 * The correction loop completes for either `none` or `replan`; only `none` is ready.
 * A replan fails here with the draft PR and the canonical report intact, which is why
 * the loop's own completion cannot be the gate.
 */

import { input, refuse, report } from '../../.shared/io.ts';

const reviewReady = input('REVIEW_READY');
const reviewAction = input('REVIEW_ACTION') || 'null';
const correctionReady = input('CORRECTION_READY') || 'false';
const correctionAction = input('CORRECTION_ACTION') || 'null';

const reviewedReady = reviewReady === 'true' && reviewAction === 'none';
const correctedReady =
  reviewAction === 'correct' && correctionReady === 'true' && correctionAction === 'none';

if (reviewedReady || correctedReady) {
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
