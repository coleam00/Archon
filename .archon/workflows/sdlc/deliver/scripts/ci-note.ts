/**
 * CI evidence for one correction round, read once and never waited on.
 *
 * The note is advisory: a round proceeds on its review findings when no evidence
 * is available. A failed read still reaches the operator on stderr, so a selected
 * check source that cannot answer is visible here before `check-ci` refuses on it.
 */

import { atRevision, describeUnits, readPrChecks } from '../../.shared/checks.ts';
import { parseQualifiedPr } from '../../.shared/forge.ts';
import { note, report } from '../../.shared/io.ts';

const boundPr = process.env.INPUTS_PR;
const selected = process.env.ARCHON_SDLC_FORGE;

try {
  const read = readPrChecks(parseQualifiedPr(boundPr), selected);
  if (read.units.length === 0) {
    report(
      'No CI evidence is available for this round (no checks reported). Proceed on the review findings alone.'
    );
  } else {
    const failing = read.units.filter(unit => unit.state === 'red' || unit.state === 'unknown');
    const pending = read.units.filter(unit => unit.state === 'pending');
    const gated = read.units.filter(unit => unit.state === 'gated');
    const lines = [
      `CI state for this pull request${atRevision(read)}, read at the start of this round; it describes the currently pushed head:`,
      failing.length > 0
        ? `Concluded non-green checks:\n${failing.map(unit => `- ${unit.unit.name} (${unit.result ?? unit.state})`).join('\n')}`
        : 'No concluded failures.',
    ];
    if (pending.length > 0)
      lines.push(`${pending.length} check(s) still running — never wait on them.`);
    if (gated.length > 0) lines.push(`Gated on a maintainer: ${describeUnits(gated)}.`);
    report(lines.join('\n'));
  }
} catch (error) {
  note(`ci-note: ${error instanceof Error ? error.message : String(error)}`);
  report(
    'No CI evidence is available for this round (the check read failed). Proceed on the review findings alone.'
  );
}
