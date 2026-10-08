/**
 * Push a correction's commits to the pull request's head branch and read it back.
 *
 * The fix passes commit and stop; this owns the push, so a review round or the CI
 * check never starts on a head the pull request does not have. See
 * ../../.shared/push.ts for how the target is chosen and verified.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: `$pr.output`, the run's verified pull-request record.
 */

import { parsePrRecord } from '../../.shared/forge.ts';
import { refuse, report, text } from '../../.shared/io.ts';
import { pushHead } from '../../.shared/push.ts';

try {
  const pr = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  report(`push-head: ${pr.head} is at ${pushHead(pr)}`);
} catch (error) {
  refuse(`push-head: ${error instanceof Error ? error.message : String(error)}`);
}
