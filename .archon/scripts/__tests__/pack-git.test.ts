/**
 * The pack's git steps, against real repositories: which remote holds a repository
 * (by URL, never by name), the push the workflow owns, the base-sync verification,
 * and reviewer scratch cleanup.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { urlRepo } from '../../workflows/sdlc/.shared/remote';
import { PR, forgePrRecord, gitCheckout, runPackScript, type ScriptRun } from './deliver-checks-harness';

const track = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

describe('remote identity', () => {
  it('reads one repository from every URL form a remote can have', () => {
    for (const url of [
      'https://github.com/owner/repo.git',
      'https://token@github.com/owner/repo',
      'git@github.com:owner/repo.git',
      'ssh://git@ssh.github.com:443/owner/repo.git',
    ]) {
      expect(urlRepo(url)?.path).toBe('owner/repo');
    }
    expect(urlRepo('/srv/git/repo.git')).toBeUndefined();
    expect(urlRepo('C:\\repos\\repo')).toBeUndefined();
  });
});

describe('push-head', () => {
  it('pushes to the remote that holds the head repository, whatever it is named, and reads it back', () => {
    const cwd = gitCheckout();
    git(cwd, 'remote', 'add', 'origin', 'https://github.com/someone/fork.git');
    const run = runPackScript('deliver/scripts/push-head', { cwd, inputs: { INPUTS_PR: JSON.stringify(forgePrRecord()) } });
    expect(run.code).toBe(0);
    expect(git(cwd, 'ls-remote', 'upstream', 'refs/heads/feature').split(/\s+/)[0]).toBe(git(cwd, 'rev-parse', 'HEAD'));
  });

  it('refuses a push the remote rejects instead of skipping it', () => {
    const cwd = gitCheckout();
    git(cwd, 'push', '-q', 'upstream', 'feature');
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'local');
    git(cwd, 'checkout', '-q', '--detach', 'HEAD~2');
    const run = runPackScript('deliver/scripts/push-head', { cwd, inputs: { INPUTS_PR: JSON.stringify(forgePrRecord()) } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('refused');
  });

  it('refuses when two remotes claim the same repository', () => {
    const cwd = gitCheckout();
    git(cwd, 'remote', 'add', 'mirror', `git@${PR.repo.host}:${PR.repo.path}.git`);
    const run = runPackScript('deliver/scripts/push-head', { cwd, inputs: { INPUTS_PR: JSON.stringify(forgePrRecord()) } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('ambiguous');
  });
});

describe('verify-sync', () => {
  const verify = (
    cwd: string,
    extra: Record<string, string> = {},
    listing = '{"artifactsByType":{},"errors":[]}'
  ): ScriptRun =>
    runPackScript('pr/scripts/verify-sync', {
      cwd,
      inputs: {
        INPUTS_REPO: JSON.stringify(PR.repo),
        INPUTS_BASE: 'dev',
        INPUTS_CONFLICTS: '[]',
        INPUTS_SUMMARY: 'stub',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
        ...extra,
      },
      artifacts: { 'listing.json': listing },
    });

  it('refuses a merge that left conflicts, naming the paths', () => {
    const run = verify(gitCheckout(), { INPUTS_CONFLICTS: JSON.stringify(['a.txt']), INPUTS_SUMMARY: 'both sides rewrote it' });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('a.txt');
    expect(run.stderr).toContain('both sides rewrote it');
  });

  it('refuses a branch the latest base was not merged into', () => {
    const run = verify(gitCheckout({ conflict: true }));
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('upstream/dev is not an ancestor of HEAD');
  });

  it('cites a clean green recorded for this exact commit instead of gating it again', () => {
    const cwd = gitCheckout();
    const head = git(cwd, 'rev-parse', 'HEAD');
    const listing = JSON.stringify({ artifactsByType: { 'green-gate': [{ path: 'gate.json' }] }, errors: [] });
    const recorded = runPackScript('pr/scripts/verify-sync', {
      cwd,
      inputs: {
        INPUTS_REPO: JSON.stringify(PR.repo),
        INPUTS_BASE: 'dev',
        INPUTS_CONFLICTS: '[]',
        INPUTS_SUMMARY: 'stub',
        TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
      },
      artifacts: {
        'listing.json': listing,
        'gate.json': JSON.stringify({ gate: 'green', red_cause: '', stage: 'x', summary: '', head }),
      },
    });
    expect(JSON.parse(recorded.stdout)).toEqual({ recorded: true });
    expect(JSON.parse(verify(cwd).stdout)).toEqual({ recorded: false });
  });
});

describe('prune-scratch', () => {
  it("removes the run's scratch worktrees and nothing else", () => {
    const cwd = gitCheckout();
    const artifacts = track(mkdtempSync(join(tmpdir(), 'archon-scratch-')));
    const scratch = join(artifacts, 'scratch', 'code');
    mkdirSync(scratch, { recursive: true });
    git(cwd, 'worktree', 'add', '-q', '--detach', join(scratch, 'one'), 'HEAD');
    const oneSpellings = [join(scratch, 'one'), realpathSync.native(join(scratch, 'one'))].map(path =>
      path.split(sep).join('/')
    );
    const user = track(mkdtempSync(join(tmpdir(), 'archon-user-wt-')));
    git(cwd, 'worktree', 'add', '-q', '--detach', join(user, 'mine'), 'HEAD');
    writeFileSync(join(cwd, 'untracked.txt'), 'kept');

    const run = spawnSync(process.execPath, [join(import.meta.dir, '../../workflows/sdlc/review/scripts/prune-scratch.ts')], {
      cwd,
      env: { ...process.env, ARTIFACTS_DIR: artifacts, INPUTS_LENS: '' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    // git prints a worktree's long, forward-slash path; tmpdir() can be a symlink (macOS)
    // or an 8.3 short name (Windows). Every path is compared in both spellings.
    const slashes = (path: string): string => path.split(sep).join('/');
    const spellings = (path: string): string[] => [slashes(path), slashes(realpathSync.native(path))];
    const listed = git(cwd, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => slashes(line.slice('worktree '.length)));
    expect(listed.some(path => oneSpellings.includes(path))).toBe(false);
    expect(listed.some(path => spellings(join(user, 'mine')).includes(path))).toBe(true);
    expect(existsSync(join(artifacts, 'scratch'))).toBe(false);
    expect(existsSync(join(cwd, 'untracked.txt'))).toBe(true);
  });
});
