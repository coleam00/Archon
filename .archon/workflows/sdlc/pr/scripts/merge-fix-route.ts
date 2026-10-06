/**
 * Whether the merged tree's one correction left red that needs the operator.
 *
 * It asks the green gate's own decision (../../.shared/gate.ts) without refusing:
 * whatever that gate would refuse pauses the delivery for the operator, who
 * corrects the merged tree once more, instead of failing it. Everything the gate
 * passes, green or red the change is not shown to cause, goes on through the gate.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_GREEN: the correction's verdict, canonical boolean text.
 * - INPUTS_RED_CAUSE: its declared cause, or '' when none was declared.
 * - INPUTS_SUMMARY: its summary, the evidence for a declared cause.
 */

import { gateRefusal } from '../../.shared/gate.ts';
import { emit, trimmed } from '../../.shared/io.ts';

const refusal = gateRefusal({
  green: trimmed(process.env.INPUTS_GREEN),
  cause: trimmed(process.env.INPUTS_RED_CAUSE),
  summary: trimmed(process.env.INPUTS_SUMMARY),
  stage: 'The merged tree after its correction',
});
emit({ attention: refusal !== undefined });
