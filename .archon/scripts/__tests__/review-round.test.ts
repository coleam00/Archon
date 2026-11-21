/**
 * review-round fixes what a review round reviews: the checkout's HEAD, and on a
 * continuation the previous round's reviewed commit, which that head must descend
 * from. The stale case is a round whose checkout sits on an ancestor of the commit
 * the previous round reviewed: its delta would run backwards and reopen findings
 * the newer commits fixed.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from './temp-roots';
import { PR_URL, packScriptRunner, type ScriptRun } from './deliver-checks-harness';

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
  it("continues a new run's first review from the report an earlier run published, and reviews from the start without one", () => {
    const { cwd, older, newer } = history();
    // An earlier run's artifacts: its published report, the commit it reviewed, and an open tests blocker.
    const earlier = join(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-earlier-run-'))), 'review');
    mkdirSync(earlier);
    writeFileSync(join(earlier, 'report.md'), 'Not ready');
    writeFileSync(join(earlier, 'reviewed-head'), `${older}\n`);
    const blocker = { id: 'R1', severity: 'blocking', sources: ['tests'], claim: 'c', status: 'open', round: 2 };
    writeFileSync(join(earlier, 'findings.json'), JSON.stringify([blocker]));
    const mode = (prior: string): Record<string, unknown> => {
      const run = runPackScript('review/scripts/review-round', {
        cwd,
        inputs: { INPUTS_PRIOR_REPORT: prior, INPUTS_PART: '', ARCHON_NODE_EXECUTION: JSON.stringify(execution(newer)) },
      });
      expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' });
      return JSON.parse(run.stdout) as Record<string, unknown>;
    };

    expect(mode(join(earlier, 'report.md'))).toMatchObject({ continuation: true, head: newer, cursor: older, code: true, tests: true, seams: false });
    // No report: a first review of the whole change.
    expect(mode('')).toMatchObject({ continuation: false, head: newer, cursor: '', code: false, tests: false });
  });

  // A standalone review of a pull request started from another checkout: the round
  // refuses at its first node, before any agent has spent anything on it.
  it("refuses a pull-request URL scope when the checkout is not at that pull request's head", () => {
    const { cwd, older, newer } = history();
    const scoped = (head: string): ScriptRun =>
      runPackScript('review/scripts/review-round', {
        cwd,
        tracker: { pr: { headRefOid: newer } },
        inputs: { INPUTS_SCOPE: PR_URL, ARCHON_NODE_EXECUTION: JSON.stringify(execution(head)) },
      });

    const wrong = scoped(older);
    expect(wrong.code).not.toBe(0);
    expect(wrong.stdout).toBe('');

    const matching = scoped(newer);
    expect(matching.code).toBe(0);
    expect(JSON.parse(matching.stdout)).toMatchObject({ continuation: false, head: newer });
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
