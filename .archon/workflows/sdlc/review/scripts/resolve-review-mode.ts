/**
 * Full review, or continuation over a prior round's report.
 *
 * The report reaches this workflow as a path string, so its existence is the one
 * thing worth checking before the lenses are skipped on the strength of it: a
 * continuation that cannot read the report it is continuing from would review
 * nothing and say it reviewed everything.
 */

import { statSync } from 'node:fs';
import { emit, refuse, trimmedInput } from '../../.shared/io.ts';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const priorReport = trimmedInput('PRIOR_REPORT');
if (priorReport !== '' && !isFile(priorReport)) {
  refuse(`Previous review report does not exist: ${priorReport}`);
} else {
  emit({ continuation: priorReport !== '' });
}
