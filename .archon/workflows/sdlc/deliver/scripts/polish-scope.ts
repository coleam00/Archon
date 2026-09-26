/**
 * Does the converged review leave Suggestions for the owner to judge?
 *
 * A ready verdict ends the correction loop, and Suggestions never block it, so
 * without this pass a valid simplification or corrected claim would ship open.
 * The review's own attributed record, `review/findings.json`, answers the
 * question: an open Suggestion means one more implementation pass that fixes or
 * declines each one. That pass needs no further review round; CI on its pushed
 * head is its proof.
 *
 * A missing or unreadable record means synthesis did not write one. That is
 * reported on stderr and treated as nothing to polish: the review itself
 * already certified readiness, and this pass only adds work on top of it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, note } from '../../.shared/io.ts';

interface Finding {
  readonly severity?: unknown;
  readonly status?: unknown;
}

let polish = false;
try {
  const findings = JSON.parse(
    readFileSync(join(artifactsDir(), 'review', 'findings.json'), 'utf8')
  ) as unknown;
  if (!Array.isArray(findings)) throw new Error('findings.json is not an array');
  polish = (findings as Finding[]).some(
    finding => finding.severity === 'Suggestion' && finding.status === 'open'
  );
} catch (error) {
  note(
    `polish-scope: no readable review/findings.json (${error instanceof Error ? error.message : String(error)}); nothing to polish.`
  );
}
emit({ polish });
