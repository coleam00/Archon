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

import { emit, refuse, trimmed } from '../../.shared/io.ts';

function commitOf(label: string, text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not a checkout observation`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a checkout observation`);
  }
  const observation = value as { kind?: unknown; commit?: unknown; reason?: unknown };
  if (observation.kind !== 'git' || typeof observation.commit !== 'string') {
    const reason = typeof observation.reason === 'string' ? ` (${observation.reason})` : '';
    throw new Error(`${label} names no commit${reason}`);
  }
  return observation.commit;
}

try {
  const since = commitOf('the earlier pass start', trimmed(process.env.INPUTS_SINCE));
  const execution = JSON.parse(trimmed(process.env.ARCHON_NODE_EXECUTION)) as {
    attempt?: { checkoutStart?: unknown };
  };
  const current = commitOf(
    'this node start',
    JSON.stringify(execution.attempt?.checkoutStart ?? null)
  );
  emit({ moved: current !== since });
} catch (error) {
  refuse(`delta-scope: ${error instanceof Error ? error.message : String(error)}`);
}
