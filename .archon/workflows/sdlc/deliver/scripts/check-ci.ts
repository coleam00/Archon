/**
 * Classify the recorded pull request's check state, once.
 *
 * This is the single-shot probe inside the `await-checks` loop_group: the engine's
 * durable `wait:` node owns the time between probes, so this script reads the state,
 * declares it, and exits. The checks come from the pack's one reader
 * (`.shared/checks.ts`): `gh` by default, `archon forge checks` when the operator
 * opts in with `ARCHON_SDLC_FORGE=forge`.
 *
 * States, declared through this node's `output_format` so `when:` and `until_bash`
 * branch on a certified field rather than on prose:
 *   pending    some check is still running
 *   concluded  green, no CI configured, or CI gated on a maintainer's approval (fork
 *              or first contribution) — a gate only a maintainer can open, named,
 *              never blocked on and never called green
 *   red        concluded with non-green checks, named. A cancelled or unrecognized
 *              check is not a green check.
 *
 * Red is a report, never a verdict: the deliver tail's convergence pass decides what
 * it means. A failed read refuses: it is never evidence that no CI exists.
 *
 * The one in-process wait: when nothing has registered yet, registration gets a
 * single 60 s grace before the maintainer-gated skip is declared. The gh source first
 * asks whether the repository has any active workflow, so a repository without CI
 * skips the wait.
 */

import {
  atRevision,
  describeUnits,
  gateState,
  hasActiveWorkflows,
  readPrChecks,
  type CheckRead,
} from '../../.shared/checks.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, refuse } from '../../.shared/io.ts';

/** The recorded pull request, so no read ever falls back to the ambient branch. */
const boundPr = process.env.INPUTS_PR;
const selected = process.env.ARCHON_SDLC_FORGE;

function classify(read: CheckRead): void {
  const at = atRevision(read);
  const units = read.units;
  switch (gateState(units)) {
    case 'pending': {
      const count = units.filter(unit => unit.state === 'pending').length;
      emit({ state: 'pending', detail: `${count} check(s) running${at}` });
      return;
    }
    case 'red': {
      const parts: string[] = [];
      const red = units.filter(unit => unit.state === 'red');
      const unknown = units.filter(unit => unit.state === 'unknown');
      if (red.length > 0) parts.push(`non-green checks${at}: ${describeUnits(red)}`);
      if (unknown.length > 0) parts.push(`checks have unknown state${at}: ${describeUnits(unknown)}`);
      emit({ state: 'red', detail: parts.join('; ') });
      return;
    }
    case 'gated':
      emit({
        state: 'concluded',
        detail: `checks gated${at}: ${describeUnits(units.filter(unit => unit.state === 'gated'))}`,
      });
      return;
    case 'green': {
      const skipped = units.filter(unit => unit.result === 'skipped');
      const note =
        skipped.length > 0
          ? `; skipped (non-blocking): ${skipped.map(unit => unit.unit.name).join(', ')}`
          : '';
      emit({
        state: 'concluded',
        detail: `all ${units.length} observed check(s) green${at}${note}`,
      });
      return;
    }
    case 'none':
      return;
  }
}

function probe(): void {
  const pr = parseQualifiedPr(boundPr);
  const first = readPrChecks(pr, selected);
  if (first.units.length > 0) {
    classify(first);
    return;
  }
  if (first.source === 'gh' && hasActiveWorkflows(pr) === false) {
    emit({ state: 'concluded', detail: 'no checks configured on this repository — nothing to await' });
    return;
  }
  // CI exists (or could not be ruled out) but nothing started. Give registration one
  // grace interval, then skip with the reason: starting gated CI is a maintainer's
  // power, not this run's.
  Bun.sleepSync(60_000);
  const second = readPrChecks(pr, selected);
  if (second.units.length > 0) {
    classify(second);
    return;
  }
  emit({
    state: 'concluded',
    detail:
      `CI is configured but no checks started on this PR${atRevision(second)} — most likely ` +
      "awaiting a maintainer's approval to run (fork or first contribution), or path " +
      'filters. Skipping the CI gate; running and verifying checks stays with the maintainer.',
  });
}

try {
  probe();
} catch (error) {
  refuse(`check-ci: ${error instanceof Error ? error.message : String(error)}`);
}
