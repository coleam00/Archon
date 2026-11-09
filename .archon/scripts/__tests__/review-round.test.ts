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
import { trackTempRoots } from './temp-roots';
import { packScriptRunner, type ScriptRun } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

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

/** The engine identity review-round reads its checkout start from. */
function execution(head: string): object {
  return {
    path: 'review__mode',
    invocation: { loopPath: [{ groupId: 'delivery', iteration: 2 }] },
    attempt: { checkoutStart: { kind: 'git', commit: head } },
  };
}

function round(
  cwd: string,
  head: string,
  cursor?: string,
  extra: { part?: string; findings?: unknown[] | null } = {}
): ScriptRun {
  const findings = extra.findings === undefined ? [] : extra.findings;
  return runPackScript('review/scripts/review-round', {
    cwd,
    inputs: {
      INPUTS_PRIOR_REPORT: cursor === undefined ? '' : '{ARTIFACTS}/review/report.md',
      INPUTS_PART: extra.part ?? '',
      ARCHON_NODE_EXECUTION: JSON.stringify(execution(head)),
    },
    artifacts:
      cursor === undefined
        ? {}
        : {
            'review/report.md': 'Round 1',
            'review/reviewed-head': `${cursor}\n`,
            ...(findings === null ? {} : { 'review/findings.json': JSON.stringify(findings) }),
          },
  });
}

describe('review-round', () => {

  it("continues from the previous round's reviewed commit with code and every lens owing a blocker", () => {
    const { cwd, older, newer } = history();
    const part = { delivers: 1, parts: [{ part: 2, items: ['later'] }] };
    const finding = (id: string, severity: string, status: string, sources: string[]): object => ({
      id, severity, status, sources, claim: id, round: 1, ...(severity === 'blocking' ? { action: 'correct' } : {}),
    });
    const findings = [
      finding('R1', 'blocking', 'open', ['seams', 'contract']),
      finding('R2', 'note', 'open', ['tests']),
      finding('R3', 'blocking', 'fixed', ['errors']),
    ];
    const run = round(cwd, newer, older, { part: JSON.stringify(part), findings });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      continuation: true,
      head: newer,
      cursor: older,
      risks: FULL_REVIEW_RISKS,
      seams: true, code: true, tests: false, errors: false, docs: false, ux: false,
      part,
    });
  });

  it("refuses a continuation whose previous report has no findings.json beside it", () => {
    const { cwd, older, newer } = history();
    const run = round(cwd, newer, older, { findings: null });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('findings.json');
  });

  it('refuses a head that is an ancestor of the commit the previous round reviewed', () => {
    const { cwd, older, newer } = history();
    const run = round(cwd, older, newer);
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`at ${older}, which does not descend from ${newer}`);
  });
});
