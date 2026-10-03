/**
 * Did the CI fix commit anything?
 *
 * The CI fix runs after the review converged, so commits it made need a review
 * round of their own, and only when there are any: a fix that classified the red
 * as inherited or environmental pushed nothing. Both ends are the engine's own
 * checkout observations: `since` is the observation recorded when the fix started,
 * and the current one is this node's start. Only commits count: every pass that
 * changes code commits it, and nothing uncommitted ships.
 *
 * An observation that names no commit cannot bound the delta, so the node
 * refuses rather than guessing and skipping or reviewing the wrong commits.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_SINCE: `$ci-fix.execution.checkoutStart`.
 */

import { nodeStartCommit, observedCommit } from '../../.shared/checkout.ts';
import { emit, refuse, trimmed } from '../../.shared/io.ts';

try {
  let observation: unknown;
  try {
    observation = JSON.parse(trimmed(process.env.INPUTS_SINCE));
  } catch {
    throw new Error('the earlier pass start is not a checkout observation');
  }
  const since = observedCommit('the earlier pass start', observation);
  emit({ moved: nodeStartCommit() !== since });
} catch (error) {
  refuse(`delta-scope: ${error instanceof Error ? error.message : String(error)}`);
}
