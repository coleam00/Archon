import { preferredChecks, readChecks } from '../../.shared/forge.ts';
import { report } from '../../.shared/io.ts';

try {
  const observation = readChecks(process.env.INPUTS_PR);
  const checks = preferredChecks(observation);
  const red = checks.units.filter(unit => unit.state === 'red' || unit.state === 'unknown');
  const pending = checks.units.filter(unit => unit.state === 'pending');
  const gated = checks.units.filter(unit => unit.state === 'gated');
  const lines = [`CI state at revision ${observation.revision}: ${checks.summary.state}.`];
  if (red.length > 0)
    lines.push(
      `Concluded non-green checks:\n${red.map(unit => `- ${unit.unit.name} (${unit.result ?? unit.state})`).join('\n')}`
    );
  else lines.push('No concluded failures.');
  if (pending.length > 0)
    lines.push(`${pending.length} check(s) still running — never wait on them.`);
  if (gated.length > 0)
    lines.push(`Gated checks: ${gated.map(unit => unit.unit.name).join(', ')}.`);
  report(lines.join('\n'));
} catch (error) {
  report(
    `No CI evidence is available for this round (the check read failed: ${error instanceof Error ? error.message : String(error)}). Proceed on the review findings alone.`
  );
}
