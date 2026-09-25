/**
 * Publish the resynced pull-request body.
 *
 * The preceding node judges which claims the final diff falsified and writes the
 * complete replacement body; this node performs the edit and verifies it, or
 * reports that the body was already accurate and nothing was written.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_INTENT: path to the JSON intent the preparing node wrote.
 */

import { readFileSync } from 'node:fs';
import { editPrBody } from '../../.shared/pr.ts';
import { forgeSource, parsePrRecord, record } from '../../.shared/forge.ts';
import { emit, refuse, text } from '../../.shared/io.ts';

try {
  const source = forgeSource(process.env.ARCHON_SDLC_FORGE);
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const intent = record(JSON.parse(readFileSync(text(process.env.INPUTS_INTENT), 'utf8')));
  if (!intent) throw new Error('the body intent must be a JSON object');
  if (intent.change === false) emit(pr);
  else if (intent.change !== true || typeof intent.bodyPath !== 'string' || intent.bodyPath === '')
    throw new Error('the body intent must declare change true with a bodyPath, or change false');
  else emit(editPrBody(pr, intent.bodyPath, source));
} catch (error) {
  refuse(`publish-pr-body: ${error instanceof Error ? error.message : String(error)}`);
}
