/**
 * Whether the pull request's checks are still running: the wake condition of the
 * durable CI wait, and nothing more.
 *
 * What a concluded red means is the owner's judgment (`finish`), and whether the run
 * may report delivery is decided by `outcome` from its own read. This probe only
 * keeps the run asleep while CI works. Nothing registered yet counts as running when
 * the repository has CI configured: right after a push the head has no checks, and
 * concluding then would hand the owner an empty read. A repository whose CI never
 * starts on the PR exhausts the loop's iteration bound and fails the run.
 *
 * Bound input: INPUTS_PR, the owner's qualified PR reference.
 */

import {
  approvalPending,
  atRevision,
  describeUnits,
  gateState,
  hasActiveWorkflows,
  readPrChecks,
} from '../../.shared/checks.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, refuse } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;

try {
  const pr = parseQualifiedPr(boundPr);
  const read = readPrChecks(pr);
  const at = atRevision(read);
  const state = gateState(read.units, approvalPending(read));
  if (state === 'pending') {
    const running = read.units.filter(unit => unit.state === 'pending');
    emit({ state: 'pending', detail: `running${at}: ${describeUnits(running)}` });
  } else if (state === 'none' && read.source === 'gh' && hasActiveWorkflows(pr) !== false) {
    emit({ state: 'pending', detail: `no checks registered yet${at}` });
  } else {
    emit({ state: 'concluded', detail: `${state}${at}: ${describeUnits(read.units)}` });
  }
} catch (error) {
  refuse(`probe: ${error instanceof Error ? error.message : String(error)}`);
}
