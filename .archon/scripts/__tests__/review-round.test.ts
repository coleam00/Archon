/**
 * review-round fixes what a review round reviews: the checkout's HEAD, and on a
 * continuation the previous round's reviewed commit, which that head must descend
 * from. The stale case is a round whose checkout sits on an ancestor of the commit
 * the previous round reviewed: its delta would run backwards and reopen findings
 * the newer commits fixed.
 */
import { FULL_REVIEW_RISKS } from '../../workflows/sdlc/.shared/review-policy';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from './temp-roots';
import { packScriptRunner, PR, type ScriptRun } from './deliver-checks-harness';

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

/** The engine identity review-round passes through for synthesis to count lenses by. */
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
  extra: { light?: boolean; part?: string } = {}
): ScriptRun {
  return runPackScript('review/scripts/review-round', {
    cwd,
    inputs: {
      INPUTS_PRIOR_REPORT: cursor === undefined ? '' : '{ARTIFACTS}/review/report.md',
      INPUTS_LIGHT: extra.light ? 'true' : 'false',
      INPUTS_PART: extra.part ?? '',
      INPUTS_PR: 'null',
      INPUTS_SCOPE: '',
      ARCHON_NODE_EXECUTION: JSON.stringify(execution(head)),
    },
    artifacts:
      cursor === undefined
        ? {}
        : {
            'review/report.md': 'Round 1',
            'review/reviewed-head': `${cursor}\n`,
          },
  });
}

describe('review-round', () => {
  it('reviews the checkout head on a first round', () => {
    const { cwd, newer } = history();
    const run = round(cwd, newer);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      source: 'checkout',
      base: '',
      continuation: false,
      light: false,
      head: newer,
      cursor: '',
      risks: FULL_REVIEW_RISKS,
      execution: execution(newer),
      seams: false, code: false, tests: false, errors: false, docs: false,
      part: null,
    });
  });

  // The route agent adds every other lens a continuation earns; the code lens is
  // the one this round always reruns, whatever an earlier round ran.
  it("continues from the previous round's reviewed commit with the code lens alone", () => {
    const { cwd, older, newer } = history();
    const part = { delivers: 1, parts: [{ part: 2, items: ['later'] }] };
    const run = round(cwd, newer, older, { part: JSON.stringify(part) });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      source: 'checkout',
      base: '',
      continuation: true,
      light: false,
      head: newer,
      cursor: older,
      risks: FULL_REVIEW_RISKS,
      execution: execution(newer),
      seams: false, code: true, tests: false, errors: false, docs: false,
      part,
    });
  });

  it('refuses a part assignment that is not JSON without echoing it', () => {
    const { cwd, newer } = history();
    const run = round(cwd, newer, undefined, { part: 'deliver chunk 1 of #42' });
    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('the part input is not JSON');
    for (const fragment of ['deliver', 'chunk', '#42']) expect(run.stderr).not.toContain(fragment);
  });

  it('runs the code lens alone on a light continuation', () => {
    const { cwd, older, newer } = history();
    expect(JSON.parse(round(cwd, newer, older, { light: true }).stdout)).toMatchObject({
      light: true,
      seams: false,
      code: true,
      tests: false,
      errors: false,
      docs: false,
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
        INPUTS_PR: 'null',
        INPUTS_SCOPE: '',
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

describe('standalone PR revision review', () => {
  function repository(fork = false): { cwd: string; older: string; newer: string; builder: string } {
    const { cwd, older, newer } = history();
    const remote = join(cwd, 'remote.git');
    git(cwd, 'clone', '--bare', '-q', '.', remote);
    git(cwd, '--git-dir', remote, 'branch', 'base', older);
    git(cwd, '--git-dir', remote, 'branch', 'topic', newer);
    git(cwd, 'remote', 'add', 'canonical', 'https://ghe.example.com/example/repo.git');
    git(cwd, 'config', `url.${remote}.insteadOf`, 'https://ghe.example.com/example/repo.git');
    if (fork) git(cwd, 'config', '--add', `url.${remote}.insteadOf`, 'https://ghe.example.com/contributor/repo.git');
    git(cwd, 'checkout', '--detach', older);
    const builder = join(cwd, 'builder');
    git(cwd, 'worktree', 'add', '-b', 'builder', builder, newer);
    writeFileSync(join(cwd, 'file.txt'), 'reader local edit');
    writeFileSync(join(builder, 'file.txt'), 'builder local edit');
    return { cwd, older, newer, builder };
  }

  function pinned(cwd: string, checkout: string, head: string, fork = false, cursor?: string): ScriptRun {
    return runPackScript('review/scripts/review-round', {
      cwd, source: 'gh',
      gh: { pr: { headRefName: 'topic', headRefOid: head, baseRefName: 'base',
        ...(fork ? { headRepositoryOwner: { login: 'contributor' } } : {}) } },
      inputs: {
        INPUTS_PR: JSON.stringify(PR), INPUTS_SCOPE: String(PR.number),
        INPUTS_PRIOR_REPORT: cursor ? '{ARTIFACTS}/review/report.md' : '',
        INPUTS_PART: '', INPUTS_LIGHT: 'false',
        ARCHON_NODE_EXECUTION: JSON.stringify(execution(checkout)),
      },
      artifacts: { 'review/scope.md': 'Accepted contract',
        ...(cursor ? { 'review/report.md': 'Previous report', 'review/reviewed-head': cursor } : {}) },
    });
  }

  it.each([false, true])('pins a fresh PR head and leaves readers and builder untouched (fork: %s)', fork => {
    const { cwd, older, newer, builder } = repository(fork);
    const before = git(cwd, 'worktree', 'list', '--porcelain');
    const first = pinned(cwd, older, newer, fork);
    expect(first.code).toBe(0);
    const facts = JSON.parse(first.stdout);
    expect(facts).toMatchObject({ source: 'revision', head: newer, base: older });
    expect(readFileSync(join(first.artifacts, 'review/scope.md'), 'utf8')).toContain(`git show ${newer}:<path>`);
    expect(git(cwd, 'show', `${facts.head}:file.txt`)).toBe('newer');
    expect(git(cwd, 'worktree', 'list', '--porcelain')).toBe(before);
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('reader local edit');
    expect(readFileSync(join(builder, 'file.txt'), 'utf8')).toBe('builder local edit');

    git(builder, 'add', 'file.txt');
    git(builder, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'next');
    const next = git(builder, 'rev-parse', 'HEAD');
    git(builder, 'push', 'canonical', 'HEAD:topic');
    writeFileSync(join(builder, 'file.txt'), 'unfinished next round');
    const second = pinned(cwd, older, next, fork, newer);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ source: 'revision', continuation: true, head: next, cursor: newer });
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(older);
    expect(git(builder, 'rev-parse', 'HEAD')).toBe(next);
    expect(readFileSync(join(builder, 'file.txt'), 'utf8')).toBe('unfinished next round');
    expect(readFileSync(join(first.artifacts, 'review/scope.md'), 'utf8')).toContain(newer);
  });

  it('keeps the engine-observed build checkout for a composed delivery', () => {
    const { cwd, newer } = history();
    const result = runPackScript('review/scripts/review-round', {
      cwd, source: 'gh',
      inputs: {
        INPUTS_PR: JSON.stringify(PR), INPUTS_SCOPE: JSON.stringify(PR),
        INPUTS_PRIOR_REPORT: '', INPUTS_LIGHT: 'false', INPUTS_PART: '',
        ARCHON_NODE_EXECUTION: JSON.stringify(execution(newer)),
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ source: 'checkout', head: newer });
    expect(result.gh).toEqual([]);
  });

  it('refuses a PR whose fetched branch no longer matches the selected head', () => {
    const { cwd, older, builder } = repository();
    const result = pinned(cwd, older, older);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('PR head changed while fetching');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(older);
    expect(readFileSync(join(builder, 'file.txt'), 'utf8')).toBe('builder local edit');
  });
});
