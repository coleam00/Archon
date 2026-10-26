/**
 * The pack's default policy documents, written into this run's artifacts.
 *
 * A run captures the pack's source before it starts and keeps only `.ts`, `.js` and `.py` files
 * from `.shared/`, so the documents in `policy/` never reach a run as files (seen live, 2026-10-26:
 * triage found no default policy and stopped). Their text travels in the generated module
 * instead, and each workflow's `policy` script node writes it to `$ARTIFACTS_DIR/policy-defaults/`
 * and emits that directory; the agent reads the default and then the project's document, which
 * adds to it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir } from './io.ts';
import { POLICY_TEXTS } from './policy-texts.generated.ts';

/** Write every default policy document under this run's artifacts and return the directory. */
export function writePolicyDefaults(): string {
  const dir = join(artifactsDir(), 'policy-defaults');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(POLICY_TEXTS)) writeFileSync(join(dir, name), text);
  return dir;
}
