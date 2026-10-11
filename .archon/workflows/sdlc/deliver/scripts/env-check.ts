/**
 * Stop a correction loop that the environment, not the code, is blocking.
 *
 * Seen live: a correction loop spent all five rounds (83 and 95 minutes) on a pull
 * request whose findings were already fixed and whose validation passed, because
 * the end-to-end check could not start: another worktree's server held its port.
 * Every round's fix said so ("port 8787 was occupied", "PID 90260 ... owns port
 * 8787"), the following review asked for the same correction again, and no code
 * change could ever satisfy it.
 *
 * This runs after each correction's green gate. A round is an environment round
 * when the fix declared `red_cause: environment`, or its summary names a blocker
 * no code change in this branch can remove: a port in use, an exhausted rate or
 * usage limit, a full disk. One such round passes (the fix may have worked around
 * it, and the next review judges that). Two in a row fail the loop here, naming
 * the blocker, so the run ends in minutes with a diagnosis instead of spending the
 * remaining rounds. Facts only: a regular expression over the round's own record
 * and a per-run history file; it judges no code.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_RED_CAUSE: the fix's declared red cause, or ''.
 * - INPUTS_SUMMARY: the fix's summary for this round.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, refuse, trimmed } from '../../.shared/io.ts';

/** Blockers outside the change. Each pattern must name the condition, not a feature. */
const SIGNATURES: [string, RegExp][] = [
  ['port in use', /\bEADDRINUSE\b|address already in use|only one usage of each socket address/i],
  [
    'port in use',
    /\bport\s+\d{2,5}\s+(?:is\s+|was\s+)?(?:already\s+)?(?:in use|occupied|taken|busy|held|unavailable)\b/i,
  ],
  [
    'port in use',
    /\b(?:owns|occupies|occupied|holds|holding|occupying|blocked by|belonged to)\s+(?:the\s+)?port\s+\d{2,5}\b/i,
  ],
  ['rate or usage limit', /\b429\b[^.\n]{0,40}too many requests|too many requests[^.\n]{0,40}\b429\b/i],
  [
    'rate or usage limit',
    /\b(?:rate|usage)\s+limit\s+(?:was\s+|is\s+)?(?:reached|exceeded|hit)\b|\bhit\s+(?:the|a|its|your)\s+(?:rate|usage)\s+limit\b/i,
  ],
  ['disk full', /\bENOSPC\b|no space left on device/i],
];

interface History {
  rounds: { environment: boolean; signatures: string[] }[];
}

function matches(summary: string): string[] {
  const found = new Set<string>();
  for (const [name, pattern] of SIGNATURES) if (pattern.test(summary)) found.add(name);
  return [...found];
}

function main(): void {
  const redCause = trimmed(process.env.INPUTS_RED_CAUSE);
  const summary = trimmed(process.env.INPUTS_SUMMARY);
  const signatures = matches(summary);
  const environment = redCause === 'environment' || signatures.length > 0;
  const path = join(artifactsDir(), 'correction-environment.json');
  const history: History = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as History)
    : { rounds: [] };
  const previous = history.rounds.at(-1);
  history.rounds.push({ environment, signatures });
  writeFileSync(path, JSON.stringify(history, null, 2));
  const round = history.rounds.length;
  if (environment && previous?.environment) {
    const named = [...new Set([...previous.signatures, ...signatures])];
    refuse(
      `Correction round ${round} is blocked by the environment again ` +
        `(${named.length > 0 ? named.join(', ') : 'declared environment red'}), ` +
        'so another code correction cannot help. Stopping the correction loop instead of ' +
        `spending the remaining rounds. Clear the blocker and resume. This round's fix: ${summary}`
    );
    return;
  }
  emit({ environment, signatures, round });
}

main();
