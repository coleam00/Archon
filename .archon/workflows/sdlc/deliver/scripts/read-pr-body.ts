/**
 * Read the recorded pull request's current description for the resync node.
 *
 * The body is read from the forge rather than from what this run wrote when the
 * pull request opened: a human may have edited it since, and a resync that
 * silently reverted that edit would be a write nobody asked for. Reading it here
 * also keeps the authoring node free of the source switch.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { viewPr } from '../../.shared/pr.ts';
import { forgeSource, parsePrRecord } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, text } from '../../.shared/io.ts';

try {
  const source = forgeSource(process.env.ARCHON_SDLC_FORGE);
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const view = viewPr(pr, source);
  const path = join(artifactsDir(), 'pr-body-current.md');
  writeFileSync(path, view.body);
  emit({ body: path, url: view.pr.url });
} catch (error) {
  refuse(`read-pr-body: ${error instanceof Error ? error.message : String(error)}`);
}
