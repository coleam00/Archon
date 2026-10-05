/**
 * Classify the recorded pull request's check state, once.
 *
 * This is the single-shot probe inside the CI wait loops: the engine's durable
 * `wait:` node owns the time between probes, so this script reads the state,
 * declares it, and exits. The checks come from the pack's one reader
 * (`.shared/checks.ts`): `gh` by default, `archon forge checks` when the operator
 * opts in with `ARCHON_SDLC_FORGE=forge`.
 *
 * Which checks gate a merge is a project fact discover-ci recorded; this acts on
 * that record and never guesses from silence. States, declared through this node's
 * `output_format` so `when:` and `until_bash` branch on a certified field:
 *   pending    a check is running, or an expected check has not registered yet
 *   concluded  green; no checks expected and none registered; or CI gated on a
 *              maintainer's approval, which the forge reports structurally (an
 *              `action_required` conclusion) — named, never blocked on, never green
 *   red        concluded with non-green checks, named. A cancelled or unrecognized
 *              check is not a green check.
 *
 * Red is a report, never a verdict: the deliver tail's convergence pass decides what
 * it means. A failed read refuses: it is never evidence that no CI exists.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_EXPECTED: JSON list of the check names discover-ci expects to gate.
 */

import {
  approvalPending,
  atRevision,
  describeUnits,
  gateState,
  missingChecks,
  readPrChecks,
} from '../../.shared/checks.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, refuse, text } from '../../.shared/io.ts';

function probe(): void {
  const pr = parseQualifiedPr(process.env.INPUTS_PR);
  const expected = JSON.parse(text(process.env.INPUTS_EXPECTED)) as string[];
  const read = readPrChecks(pr);
  const at = atRevision(read);
  const units = read.units;
  const state = gateState(units);
  if (state === 'pending') {
    const count = units.filter(unit => unit.state === 'pending').length;
    emit({ state: 'pending', detail: `${count} check(s) running${at}` });
    return;
  }
  if (state === 'red') {
    const parts: string[] = [];
    const red = units.filter(unit => unit.state === 'red');
    const unknown = units.filter(unit => unit.state === 'unknown');
    if (red.length > 0) parts.push(`non-green checks${at}: ${describeUnits(red)}`);
    if (unknown.length > 0) parts.push(`checks have unknown state${at}: ${describeUnits(unknown)}`);
    emit({ state: 'red', detail: parts.join('; ') });
    return;
  }
  const missing = missingChecks(units, expected);
  if (state === 'gated' || (missing.length > 0 && approvalPending(pr, read))) {
    const gated = units.filter(unit => unit.state === 'gated');
    emit({
      state: 'concluded',
      detail:
        `checks gated on a maintainer's approval${at}` +
        (gated.length > 0 ? `: ${describeUnits(gated)}` : '') +
        (missing.length > 0 ? `; not yet run: ${missing.join(', ')}` : ''),
    });
    return;
  }
  if (missing.length > 0) {
    emit({ state: 'pending', detail: `expected check(s) not registered yet${at}: ${missing.join(', ')}` });
    return;
  }
  if (state === 'none') {
    emit({ state: 'concluded', detail: 'no checks are expected to gate this merge, and none registered' });
    return;
  }
  const skipped = units.filter(unit => unit.result === 'skipped');
  const note =
    skipped.length > 0 ? `; skipped (non-blocking): ${skipped.map(unit => unit.unit.name).join(', ')}` : '';
  emit({ state: 'concluded', detail: `all ${units.length} observed check(s) green${at}${note}` });
}

try {
  probe();
} catch (error) {
  refuse(`check-ci: ${error instanceof Error ? error.message : String(error)}`);
}
