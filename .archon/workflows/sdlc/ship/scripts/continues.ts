/**
 * The open pull request delivery continues: the one the caller resolved, else the one
 * triage routed the run to continue, else none. A caller that resolved a pull request
 * owns that fact on every route admitted to delivery. Two different numbers refuse.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_CALLER: the number the caller resolved, or empty or `null`.
 * - INPUTS_TRIAGE: the number triage's `continue` route names, or `null`.
 */

import { emit, nullableJson, refuse } from '../../.shared/io.ts';

const caller = nullableJson(process.env.INPUTS_CALLER) as number | null;
const triage = nullableJson(process.env.INPUTS_TRIAGE) as number | null;

if (caller !== null && triage !== null && caller !== triage) {
  refuse(
    `continues: the caller resolved pull request ${String(caller)}, but triage routed the run to continue ${String(triage)}`
  );
} else {
  emit({ pull_request: caller ?? triage });
}
