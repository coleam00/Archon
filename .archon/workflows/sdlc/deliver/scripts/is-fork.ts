/**
 * Is the delivered pull request's head in another repository?
 *
 * The final local validation exists for exactly that case: a fork's CI waits for
 * a maintainer's approval, so the local gate is the only check before the ready
 * flip. For a same-repository pull request, CI runs the same gate on the pushed
 * head and the implementation already ran it, so delivery skips the local rerun.
 * An unknown head repository counts as a fork: running the gate costs minutes,
 * skipping it wrongly would flip a pull request nothing validated.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */

import { parsePrRecord, sameRepo } from '../../.shared/forge.ts';
import { emit, refuse, text } from '../../.shared/io.ts';

try {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  emit({ fork: pr.head_repo === null || !sameRepo(pr.head_repo, pr.repo) });
} catch (error) {
  refuse(`is-fork: ${error instanceof Error ? error.message : String(error)}`);
}
