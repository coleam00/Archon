/**
 * Is there anything left for the owner to judge after the review converged?
 *
 * A ready verdict ends the correction loop, and notes never block it, so without
 * this pass a valid simplification or corrected claim would ship open. The same
 * holds for the delta structure pass, which reads the commits made after the
 * pre-PR one and reports after the last review. Either source means one more
 * implementation pass that fixes or declines each finding; it needs no further
 * review round, and CI on its pushed head is its proof.
 *
 * The review's own attributed record, `review/findings.json`, answers for the
 * notes. A missing or unreadable record means synthesis did not write one. That
 * is reported on stderr and counted as no open note: the review itself already
 * certified readiness, and this pass only adds work on top of it.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_DELTA_FINDINGS: `"true"` when the delta structure pass reported any
 *   finding, `"false"` when it found none or did not run.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, note, trimmed } from '../../.shared/io.ts';

interface Finding {
  readonly severity?: unknown;
  readonly status?: unknown;
}

let openNote = false;
try {
  const findings = JSON.parse(
    readFileSync(join(artifactsDir(), 'review', 'findings.json'), 'utf8')
  ) as unknown;
  if (!Array.isArray(findings)) throw new Error('findings.json is not an array');
  openNote = (findings as Finding[]).some(
    finding => finding.severity === 'note' && finding.status === 'open'
  );
} catch (error) {
  note(
    `polish-scope: no readable review/findings.json (${error instanceof Error ? error.message : String(error)}); counting no open note.`
  );
}
emit({ polish: openNote || trimmed(process.env.INPUTS_DELTA_FINDINGS) === 'true' });
