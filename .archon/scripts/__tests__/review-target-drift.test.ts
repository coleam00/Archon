import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { gitCheckout, packScriptRunner, PR, PR_URL } from './deliver-checks-harness';

const track = trackTempRoots();
const { runPackScript } = packScriptRunner();

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

function history() {
  const cwd = gitCheckout({}, track);
  const first = git(cwd, 'rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'second.txt'), 'second\n');
  git(cwd, 'add', 'second.txt');
  git(cwd, 'commit', '-qm', 'second');
  const head = git(cwd, 'rev-parse', 'HEAD');
  return {
    cwd,
    first,
    head,
    target: { pr: PR, base: 'dev', head, merge_base: git(cwd, 'merge-base', 'dev', head) },
    execution: JSON.stringify({ attempt: { checkoutStart: { kind: 'git', commit: head } } }),
  };
}

function preflight(h: ReturnType<typeof history>, target = h.target, base = 'dev') {
  return runPackScript('review/scripts/check-review-head', {
    cwd: h.cwd,
    gh: { pr: { headRefOid: h.head, baseRefName: base } },
    inputs: {
      INPUTS_SCOPE: PR_URL,
      INPUTS_SELECTOR: PR_URL,
      INPUTS_HEAD: h.head,
      INPUTS_TARGET: JSON.stringify(target),
      ARCHON_NODE_EXECUTION: h.execution,
    },
  });
}

function publish(h: ReturnType<typeof history>, target: string, base = 'dev') {
  return runPackScript('review/scripts/publish-review', {
    cwd: h.cwd,
    gh: { pr: { headRefOid: h.head, baseRefName: base } },
    inputs: {
      INPUTS_HEAD: h.head,
      INPUTS_TARGET: target,
      ARCHON_NODE_EXECUTION: h.execution,
      INPUTS_REPORT: '{ARTIFACTS}/review/report.md',
      INPUTS_READY: 'true',
      INPUTS_ACTION: 'none',
      INPUTS_SUMMARY: 'clean',
      INPUTS_REPORT_POINTER: 'null',
      INPUTS_DISCOVERIES: '[]',
      INPUTS_CONTRACT_LEFT: '[]',
      INPUTS_ROUTE: 'null',
      INPUTS_MODE: '{}',
    },
    artifacts: { 'review/report.md': 'Reviewed the pinned diff.\n' },
  });
}

describe('reviewed PR diff identity', () => {
  it('refuses a scope for another PR at the same head before lenses', () => {
    const h = history();
    const run = preflight(h, { ...h.target, pr: { ...PR, number: 99 } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('scoped PR identity does not match');
    expect(run.comments).toEqual([]);
  });

  for (const drift of ['retarget', 'same-base advance']) {
    for (const phase of ['before head-check', 'after head-check']) {
      it(`refuses a changed effective diff from ${drift} ${phase}`, () => {
        const h = history();
        const checked = phase === 'after head-check' ? preflight(h) : undefined;
        if (checked) expect(checked.code, checked.stderr).toBe(0);
        const base = drift === 'retarget' ? 'next' : 'dev';
        git(h.cwd, 'push', '-q', 'upstream', `${h.first}:refs/heads/${base}`);
        // The unchanged head has two changed files in the scoped diff, one in the new PR diff.
        expect(git(h.cwd, 'diff', '--name-only', `${h.target.merge_base}..${h.head}`)).toBe(
          'a.txt\nsecond.txt'
        );
        expect(git(h.cwd, 'diff', '--name-only', `${h.first}..${h.head}`)).toBe('second.txt');
        const run = checked ? publish(h, checked.stdout, base) : preflight(h, h.target, base);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('effective PR diff changed');
        expect(run.comments).toEqual([]);
        expect(run.stdout).toBe('');
      });
    }
  }

  it('allows retargeting and advancing the base when the effective diff is unchanged', () => {
    const h = history();
    const checked = preflight(h);
    expect(checked.code, checked.stderr).toBe(0);
    const unrelated = git(
      h.cwd,
      'commit-tree',
      'dev^{tree}',
      '-p',
      'dev',
      '-m',
      'unrelated base work'
    );
    git(h.cwd, 'push', '-q', 'upstream', `${unrelated}:refs/heads/next`);
    const rechecked = preflight(h, h.target, 'next');
    expect(rechecked.code, rechecked.stderr).toBe(0);
    const run = publish(h, checked.stdout, 'next');
    expect(run.code, run.stderr).toBe(0);
    expect(run.comments).toHaveLength(1);
    expect(run.comments[0].body).toContain(h.head);
  });
});
