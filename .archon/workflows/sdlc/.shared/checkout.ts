/**
 * The commit a checkout observation names.
 *
 * The engine samples the checkout when each exec node starts and hands the sample
 * to the node as `ARCHON_NODE_EXECUTION`; a binding can also carry an earlier
 * node's sample (`$<node>.execution.checkoutStart`). Reading the commit from those
 * observations, rather than running git again, means every script compares the
 * same engine-recorded facts. An observation that names no commit throws: a
 * caller bounding or pinning a review cannot guess one.
 */

export function observedCommit(label: string, value: unknown): string {
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

function nodeStart(): unknown {
  let execution: { attempt?: { checkoutStart?: unknown } };
  try {
    execution = JSON.parse(process.env.ARCHON_NODE_EXECUTION ?? '') as typeof execution;
  } catch {
    throw new Error('this node has no execution record; the engine supplies one to every exec node');
  }
  return execution.attempt?.checkoutStart ?? null;
}

/** The commit the checkout was at when this node started. */
export function nodeStartCommit(): string {
  return observedCommit('this node start', nodeStart());
}

/** That commit when the engine observed a clean tree, otherwise null. */
export function cleanStartCommit(): string | null {
  const start = nodeStart() as { worktree?: { status?: unknown } } | null;
  return start?.worktree?.status === 'clean' ? observedCommit('this node start', start) : null;
}
