/**
 * Publish the resynced pull-request body.
 *
 * The preceding node judges which claims the final diff falsified and writes the
 * complete replacement body; this node performs the edit and verifies it, or
 * reports that the body was already accurate and nothing was written.
 *
 * The body is a description, not a gate: an intent the agent wrote badly must not
 * fail a delivery whose code is done. An unreadable or malformed intent publishes
 * the body the contract path holds when there is one, and otherwise leaves the
 * current body as it is and says so.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 * - INPUTS_INTENT: path to the JSON intent the preparing node wrote.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { contractPath, parseAgentJson } from '../../.shared/agent-json.ts';
import { editPrBody } from '../../.shared/pr.ts';
import { forgeSource, parsePrRecord, record } from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';

try {
  const source = forgeSource();
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  const intentPath = text(process.env.INPUTS_INTENT);
  // sync-pr-body.md fixes the body at $ARTIFACTS_DIR/pr-body-final.md, beside the intent.
  const contractBody = join(dirname(intentPath), 'pr-body-final.md');
  let intent: Record<string, unknown> | undefined;
  try {
    intent = record(parseAgentJson(readFileSync(intentPath, 'utf8')));
  } catch (error) {
    note(
      `publish-pr-body: could not read the body intent (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  const declared = intent?.change;
  const change = declared === 'true' ? true : declared === 'false' ? false : declared;
  const bodyPath =
    typeof intent?.bodyPath === 'string' && intent.bodyPath !== ''
      ? contractPath(intent.bodyPath, contractBody)
      : contractBody;
  if (change === false) emit(pr);
  else if (existsSync(bodyPath)) {
    if (change !== true) note('publish-pr-body: the intent was unclear; publishing the body it wrote.');
    emit(editPrBody(pr, bodyPath, source));
  } else {
    note('publish-pr-body: no replacement body was written; the current body stays as it is.');
    emit(pr);
  }
} catch (error) {
  refuse(`publish-pr-body: ${error instanceof Error ? error.message : String(error)}`);
}
