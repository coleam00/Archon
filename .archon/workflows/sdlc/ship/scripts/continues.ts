/**
 * The open pull request delivery continues: the one the caller resolved, else the one
 * triage routed the run to continue, else none. A caller that resolved a pull request
 * owns that fact whichever route triage takes, so a plan or a direct delivery still
 * finishes it rather than opening another. A caller that resolved `none` decided the
 * run continues no pull request, as when a ruling supersedes the item's open one, so
 * triage cannot route it back onto one. Two different answers refuse.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_CALLER: the number the caller resolved, `none`, or empty or `null` when it
 *   resolved nothing.
 * - INPUTS_TRIAGE: the number triage's `continue` route names, or `null`.
 */

import { emit, nullableJson, refuse, trimmed } from '../../.shared/io.ts';

const declined = trimmed(process.env.INPUTS_CALLER) === 'none';
const caller = declined ? null : (nullableJson(process.env.INPUTS_CALLER) as number | null);
const triage = nullableJson(process.env.INPUTS_TRIAGE) as number | null;

if (declined && triage !== null) {
  refuse(`continues: the caller decided the run continues no pull request, but triage routed it to continue ${String(triage)}`);
} else if (caller !== null && triage !== null && caller !== triage) {
  refuse(
    `continues: the caller resolved pull request ${String(caller)}, but triage routed the run to continue ${String(triage)}`
  );
} else {
  emit({ pull_request: caller ?? triage });
}
