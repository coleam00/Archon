/**
 * Does this delivery run the final local project gate?
 *
 * `auto` runs it on a fork pull request only, where it is the one check before the
 * ready flip because the fork's CI waits for a maintainer. `always` runs it on
 * every delivery, for a caller that needs this run's own validation evidence
 * rather than CI's word alone. Anything else is refused: a mistyped policy must
 * not silently fall back to skipping the gate.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_FORK: `$fork.output.fork`, "true" or "false".
 * - INPUTS_POLICY: the workflow's `final_validation` input.
 */

import { emit, refuse, trimmed } from '../../.shared/io.ts';

const fork = trimmed(process.env.INPUTS_FORK);
const policy = trimmed(process.env.INPUTS_POLICY);

if (fork !== 'true' && fork !== 'false') {
  refuse(`final-gate: fork must be "true" or "false", got ${JSON.stringify(fork)}.`);
} else if (policy !== 'auto' && policy !== 'always') {
  refuse(`final-gate: final_validation must be "auto" or "always", got ${JSON.stringify(policy)}.`);
} else {
  emit({ validate: policy === 'always' || fork === 'true' });
}
