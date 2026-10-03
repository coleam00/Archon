/**
 * delta-scope decides whether delivery spends one more structure pass, and on
 * which commits. It compares two engine checkout observations: the earlier
 * pass's start, bound as `since`, and its own start.
 */
import { describe, expect, it } from 'bun:test';
import { runPackScript, type ScriptRun } from './deliver-checks-harness';

const EARLIER = 'a'.repeat(40);
const LATER = 'b'.repeat(40);

function observation(commit: string): Record<string, unknown> {
  return { kind: 'git', commit, worktree: { status: 'clean' } };
}

function scope(since: unknown, current: unknown): ScriptRun {
  return runPackScript('deliver/scripts/delta-scope', {
    inputs: {
      INPUTS_SINCE: JSON.stringify(since),
      ARCHON_NODE_EXECUTION: JSON.stringify({ attempt: { checkoutStart: current } }),
    },
  });
}

describe('delta-scope', () => {
  it('runs the pass over the commits after the earlier start', () => {
    const run = scope(observation(EARLIER), observation(LATER));
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ moved: true, base: EARLIER });
  });

  it('skips the pass when no commit landed since', () => {
    const run = scope(observation(EARLIER), observation(EARLIER));
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ moved: false, base: EARLIER });
  });

  it('refuses when the earlier start names no commit, instead of guessing a base', () => {
    const run = scope({ kind: 'unavailable', reason: 'HEAD moved while observing' }, observation(LATER));
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('names no commit (HEAD moved while observing)');
  });
});
