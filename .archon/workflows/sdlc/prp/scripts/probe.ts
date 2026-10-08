/**
 * Whether the pull request's checks are still running: the wake condition of the
 * durable CI wait, and nothing more.
 *
 * What a concluded red means is the owner's judgment (`finish`), and whether the run
 * may report delivery is decided by `outcome` from its own read. This probe only
 * keeps the run asleep while CI works. Nothing registered yet counts as running when
 * the repository has CI configured: right after a push the head has no checks, and
 * concluding then would hand the owner an empty read. That patience is bounded: after
 * UNSTARTED_LIMIT consecutive empty reads the probe concludes, and `outcome` reports
 * the typed `ci_missing` (CI configured, no checks ran: a maintainer's approval or a
 * path filter) instead of the loop exhausting its iterations and failing the run.
 *
 * Bound inputs: INPUTS_PR, the owner's qualified PR reference; INPUTS_UNSTARTED, the
 * previous iteration's `unstarted` count ('' on the first iteration).
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
const priorUnstarted = Number.parseInt(process.env.INPUTS_UNSTARTED ?? '', 10);

// Consecutive empty reads, one per durable-wait interval, before an unstarted CI concludes.
const UNSTARTED_LIMIT = 5;

try {
  const pr = parseQualifiedPr(boundPr);
  const read = readPrChecks(pr);
  const at = atRevision(read);
  const state = gateState(read.units, approvalPending(read));
  if (state === 'pending') {
    const running = read.units.filter(unit => unit.state === 'pending');
    emit({ state: 'pending', detail: `running${at}: ${describeUnits(running)}`, unstarted: 0 });
  } else if (state === 'none' && read.source === 'gh' && hasActiveWorkflows(pr) !== false) {
    const unstarted = (Number.isNaN(priorUnstarted) ? 0 : priorUnstarted) + 1;
    if (unstarted < UNSTARTED_LIMIT) {
      emit({ state: 'pending', detail: `no checks registered yet${at}`, unstarted });
    } else {
      emit({
        state: 'concluded',
        detail: `CI is configured but no checks started after ${unstarted} reads${at}`,
        unstarted,
      });
    }
  } else {
    emit({
      state: 'concluded',
      detail: `${state}${at}: ${describeUnits(read.units)}`,
      unstarted: 0,
    });
  }
} catch (error) {
  refuse(`probe: ${error instanceof Error ? error.message : String(error)}`);
}
