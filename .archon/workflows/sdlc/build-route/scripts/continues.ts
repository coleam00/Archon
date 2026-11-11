/**
 * The open pull request delivery continues: the one the caller resolved, else the one
 * a triage of this run routed it to continue, else none. A caller that resolved a pull
 * request owns that fact whichever route triage takes, so a plan or a direct delivery
 * still finishes it rather than opening another. Two different answers refuse.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_CALLER: the number the caller resolved, or empty or `null` when it resolved
 *   nothing.
 * - INPUTS_TRIAGE: the number triage's `continue` route names, or `null`.
 */

import { emit, input, refuse } from 'archon:script';
import { nullableJson } from '../../.shared/inputs.ts';

const caller = nullableJson(input('caller')) as number | null;
const triage = nullableJson(input('triage')) as number | null;

if (caller !== null && triage !== null && caller !== triage) {
  refuse(
    `continues: the caller resolved pull request ${String(caller)}, but triage routed the run to continue ${String(triage)}`
  );
} else {
  emit({ pull_request: caller ?? triage });
}
