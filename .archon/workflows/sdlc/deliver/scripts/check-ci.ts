/** Single-shot CI classifier. The surrounding workflow owns durable waiting. */

import { preferredChecks, readChecks, type CheckSet } from '../../.shared/forge.ts';
import { emit, refuse } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;

function names(checks: CheckSet, state: 'red' | 'gated' | 'unknown'): string {
  return checks.units
    .filter(unit => unit.state === state)
    .map(unit => `${unit.unit.name}${unit.result === null ? '' : ` (${unit.result})`}`)
    .join(', ');
}

function classify(checks: CheckSet, revision: string): void {
  switch (checks.summary.state) {
    case 'pending': {
      const count = checks.units.filter(unit => unit.state === 'pending').length;
      emit({ state: 'pending', detail: `${count} check(s) running at ${revision}` });
      return;
    }
    case 'green':
      emit({
        state: 'concluded',
        detail: `all ${checks.units.length} observed check(s) green at ${revision}`,
      });
      return;
    case 'gated':
      emit({
        state: 'concluded',
        detail: `checks gated at ${revision}: ${names(checks, 'gated')}`,
      });
      return;
    case 'red':
      emit({ state: 'red', detail: `non-green checks at ${revision}: ${names(checks, 'red')}` });
      return;
    case 'unknown':
      emit({
        state: 'red',
        detail: `checks have unknown state at ${revision}: ${names(checks, 'unknown')}`,
      });
      return;
    case 'none':
      return;
  }
}

try {
  const first = readChecks(boundPr);
  const preferred = preferredChecks(first);
  if (preferred.summary.state !== 'none') {
    classify(preferred, first.revision);
  } else {
    Bun.sleepSync(60_000);
    const second = readChecks(boundPr);
    const retried = preferredChecks(second);
    if (retried.summary.state === 'none') {
      emit({
        state: 'concluded',
        detail: `no checks registered after the bounded grace period at ${second.revision}`,
      });
    } else {
      classify(retried, second.revision);
    }
  }
} catch (error) {
  refuse(`check-ci: ${error instanceof Error ? error.message : String(error)}`);
}
