/**
 * The project's labeled pull requests to judge, from `CASES_PATH` in the checkout the run
 * starts in. Refused before any judge runs when the file is missing or holds too few.
 */

import { existsSync, readFileSync } from 'node:fs';
import { emit, refuse } from '../../.shared/io.ts';
import { CASES_PATH, parseCases } from '../../.shared/test-value.ts';

try {
  if (!existsSync(CASES_PATH)) {
    throw new Error(
      `no calibration labels at ${CASES_PATH} in ${process.cwd()}; label pull requests there as the SDLC pack README's "Test value" section shows`
    );
  }
  const cases = parseCases(JSON.parse(readFileSync(CASES_PATH, 'utf8')));
  emit({ cases, urls: cases.map(entry => entry.pr) });
} catch (error) {
  refuse(`cases: ${error instanceof Error ? error.message : String(error)}`);
}
