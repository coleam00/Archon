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
import { dirname, join } from 'node:path';
import { contractPath, parseAgentJson } from '../../.shared/agent-json.ts';
import { editPrBody } from '../../.shared/pr.ts';
import { forgeSource, parsePrRecord, record } from '../../.shared/forge.ts';
import { emit, refuse, text } from '../../.shared/io.ts';

try {
  const source = forgeSource();
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const intentPath = text(process.env.INPUTS_INTENT);
  const intent = record(parseAgentJson(readFileSync(intentPath, 'utf8')));
  if (!intent) throw new Error('the body intent must be a JSON object');
  if (intent.change === false) emit(pr);
  else if (intent.change !== true || typeof intent.bodyPath !== 'string' || intent.bodyPath === '')
    throw new Error('the body intent must declare change true with a bodyPath, or change false');
  // sync-pr-body.md fixes the body at $ARTIFACTS_DIR/pr-body-final.md, beside the intent.
  else emit(editPrBody(pr, contractPath(intent.bodyPath, join(dirname(intentPath), 'pr-body-final.md')), source));
} catch (error) {
  refuse(`publish-pr-body: ${error instanceof Error ? error.message : String(error)}`);
}
