/**
 * Pick the one attention item this run decides, and write nothing.
 *
 * Live: the oldest open `select` item in this project's queue that carries no
 * escalation label and has no completed decision or live owner. An unreadable select
 * item is left for a person and named on stderr. Eval: the item in the `item` input, decided
 * whatever its state, so a replay can decide an item that was answered since.
 *
 * Bound inputs: the workflow's INPUTS_MODE, INPUTS_AUTONOMY and INPUTS_ITEM.
 */

import {
  blocksDecision,
  isEscalated,
  listQueue,
  parseAutonomy,
  parseQueueItem,
  type QueueItem,
  recordName,
} from '../../.shared/attention.ts';
import { record } from '../../.shared/forge.ts';
import { emit, note, nullableJson, refuse, trimmed } from '../../.shared/io.ts';
import { POLICY_DEFAULTS } from '../../.shared/policy-defaults.ts';
import { stateGet } from '../../.shared/state.ts';
import { parseMode } from '../../.shared/workitem.ts';

/** The item as the queue printed it, so the agent reads every field the queue gives. */
function oldestEligible(): Record<string, unknown> | null {
  for (const entry of listQueue()) {
    const raw = record(entry);
    if (raw?.kind !== 'attention' || raw.form !== 'select') continue;
    let item: QueueItem;
    try {
      item = parseQueueItem(raw);
    } catch (error) {
      note(`run ${String(raw.runId)} is left for a person: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!isEscalated(item.labels) && !blocksDecision(stateGet(recordName(item.runId, item.occurrence)).value)) return raw;
  }
  return null;
}

function main(): void {
  const mode = parseMode(trimmed(process.env.INPUTS_MODE));
  parseAutonomy(trimmed(process.env.INPUTS_AUTONOMY));
  const given = nullableJson(process.env.INPUTS_ITEM);
  let item: unknown;
  if (mode === 'eval') {
    if (given === null) throw new Error('eval decides the item given in the item input, and none was given');
    parseQueueItem(given);
    item = given;
  } else {
    if (given !== null) throw new Error('the item input is for eval; live picks its item from the queue');
    item = oldestEligible();
  }
  emit({ path: item === null ? 'idle' : 'decide', item, policy_defaults: POLICY_DEFAULTS });
}

try {
  main();
} catch (error) {
  refuse(`attention-manager facts: ${error instanceof Error ? error.message : String(error)}`);
}
