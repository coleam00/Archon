/**
 * Did any commit land since an earlier structure pass judged this change?
 *
 * A structure pass judges the commits it saw. Commits made after it — review
 * corrections, a structure correction, a CI fix — need one more pass over just
 * those commits, and only when there are any. Both ends are the engine's own
 * checkout observations: `since` is the observation recorded when the earlier
 * node started, and the current one is this node's start. Only commits count:
 * every pass that changes code commits it, and nothing uncommitted ships.
 *
 * An observation that names no commit cannot bound the delta, so the node
 * refuses rather than guessing a base and judging the wrong commits.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_SINCE: `$<node>.execution.checkoutStart` of the earlier pass.
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
  emit({ moved: current !== since, base: since });
} catch (error) {
  refuse(`delta-scope: ${error instanceof Error ? error.message : String(error)}`);
}
