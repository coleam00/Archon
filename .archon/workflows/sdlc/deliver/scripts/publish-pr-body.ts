/**
 * Publish the resynced pull-request body.
 *
 * The preceding node judges which claims the final diff falsified and writes the
 * complete replacement body, or declares the body still accurate (or did not run);
 * this node performs the edit and verifies it. The red-cause block at the top is rebuilt here from the
 * gates' typed records (../../.shared/report.ts), since a gate can pass red after
 * the body was first written.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_BODY: the certified pointer to the replacement body; a declared `null`
 *   binds as empty text and means the body is still accurate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { editPrBody, viewPr } from '../../.shared/pr.ts';
import { forgeSource, parsePrRecord } from '../../.shared/forge.ts';
import { artifactsDir, emit, nullableJson, refuse, text } from '../../.shared/io.ts';
import { writePublishedBody } from '../../.shared/report.ts';

try {
  const source = forgeSource();
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const pointer = nullableJson(process.env.INPUTS_BODY) as { path: string } | null;
  const artifacts = artifactsDir();
  // With no resync the live body stays as written, but its red-cause block is still
  // rebuilt, and the edit is skipped only when nothing changed.
  const body =
    pointer === null ? viewPr(pr, source).body : readFileSync(join(artifacts, pointer.path), 'utf8');
  const published = writePublishedBody(artifacts, process.env.TYPED_ARTIFACTS_FILE, body);
  const unchanged = pointer === null && readFileSync(published, 'utf8') === body;
  emit(unchanged ? pr : editPrBody(pr, published, source));
} catch (error) {
  refuse(`publish-pr-body: ${error instanceof Error ? error.message : String(error)}`);
}
