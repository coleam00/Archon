/**
 * review-round fixes what a review round reviews: the checkout's HEAD, and on a
 * continuation the previous round's reviewed commit, which that head must descend
 * from. The stale case is a round whose checkout sits on an ancestor of the commit
 * the previous round reviewed: its delta would run backwards and reopen findings
 * the newer commits fixed.
 */
import { FULL_REVIEW_RISKS } from '../../workflows/sdlc/.shared/review-policy';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';
import { runPackScript, type ScriptRun } from './deliver-checks-harness';

const trackTempRoot = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with two commits on one line of history. */
function history(): { cwd: string; older: string; newer: string } {
  const cwd = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-review-round-')));
  git(cwd, 'init', '-q');
  const commit = (message: string): string => {
    writeFileSync(join(cwd, 'file.txt'), message);
    git(cwd, 'add', 'file.txt');
    git(
      cwd,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      message
    );
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const older = commit('older');
  const newer = commit('newer');
  return { cwd, older, newer };
}

function round(cwd: string, head: string, cursor?: string): ScriptRun {
  return runPackScript('review/scripts/review-round', {
    cwd,
    inputs: {
      INPUTS_PRIOR_REPORT: cursor === undefined ? '' : '{ARTIFACTS}/review/report.md',
      ARCHON_NODE_EXECUTION: JSON.stringify({
        path: 'review__mode',
        invocation: { loopPath: [{ groupId: 'delivery', iteration: 2 }] },
        attempt: { checkoutStart: { kind: 'git', commit: head } },
      }),
    },
    artifacts:
      cursor === undefined
        ? {}
        : { 'review/report.md': 'Round 1', 'review/reviewed-head': `${cursor}\n` },
  });
}

describe('review-round', () => {
  it('reviews the checkout head on a first round', () => {
    const { cwd, newer } = history();
    const run = round(cwd, newer);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      continuation: false,
      head: newer,
      cursor: '',
      risks: FULL_REVIEW_RISKS,
    });
  });

  it("continues from the previous round's reviewed commit to a head that descends from it", () => {
    const { cwd, older, newer } = history();
    const run = round(cwd, newer, older);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      continuation: true,
      head: newer,
      cursor: older,
      risks: FULL_REVIEW_RISKS,
    });
  });

  it('refuses a head that is an ancestor of the commit the previous round reviewed', () => {
    const { cwd, older, newer } = history();
    const run = round(cwd, older, newer);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`at ${older}, which does not descend from ${newer}`);
  });

  it('refuses a continuation whose report records no reviewed commit', () => {
    const { cwd, newer } = history();
    const run = runPackScript('review/scripts/review-round', {
      cwd,
      inputs: {
        INPUTS_PRIOR_REPORT: '{ARTIFACTS}/review/report.md',
        ARCHON_NODE_EXECUTION: JSON.stringify({
          attempt: { checkoutStart: { kind: 'git', commit: newer } },
        }),
      },
      artifacts: { 'review/report.md': 'Round 1' },
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('records no reviewed commit');
  });
});
