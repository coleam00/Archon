/**
 * Where this pack's default policy documents are.
 *
 * The defaults travel with the pack's source: a run captures that source before it
 * starts, in a binary install as in a source checkout, and its scripts run from the
 * capture. So the defaults sit beside this module, and a script finds them from its
 * own location rather than from any path the engine knows.
 *
 * This hands over a directory and nothing more. The judging agent decides between
 * the project's own policy document and the default; no code opens either.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

export function policyDefaultsDir(): string {
  const directory = join(import.meta.dir, 'policy');
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`The pack's default policy documents are missing: ${directory}`);
  }
  return directory;
}
