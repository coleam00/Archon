/**
 * The pack's git steps, against real repositories: which remote holds a repository
 * (by URL, never by name), publish-pr's push, the base-sync verification,
 * and reviewer scratch cleanup.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { urlRepo } from '../../workflows/sdlc/.shared/remote';
import { PR, forgeOperation, forgePrRecord, gitCheckout, packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
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
      'git@ssh.github.com:owner/repo.git',
      'git@SSH.GitHub.COM:owner/repo.git',
      'ssh://git@SSH.GitHub.COM:443/owner/repo.git',
    ]) {
      expect(urlRepo(url)).toEqual({ host: 'github.com', path: 'owner/repo' });
    }
    expect(urlRepo('/srv/git/repo.git')).toBeUndefined();
    expect(urlRepo('C:\\repos\\repo')).toBeUndefined();
  });
});

// pushHead is publish-pr's push; a driver runs it alone against real git remotes.
describe('pushHead', () => {
  it('pushes to the remote that holds the head repository, whatever it is named, and reads it back', () => {
    const cwd = gitCheckout({}, track);
    git(cwd, 'remote', 'add', 'origin', 'https://github.com/someone/fork.git');
    const run = runPackScript('../../scripts/__tests__/push-pr-head', { cwd, inputs: { INPUTS_PR: JSON.stringify(forgePrRecord()) } });
    expect(run.code).toBe(0);
    expect(git(cwd, 'ls-remote', 'upstream', 'refs/heads/feature').split(/\s+/)[0]).toBe(git(cwd, 'rev-parse', 'HEAD'));
  });

  it('refuses a push the remote rejects instead of skipping it', () => {
    const cwd = gitCheckout({}, track);
    git(cwd, 'push', '-q', 'upstream', 'feature');
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'local');
    git(cwd, 'checkout', '-q', '--detach', 'HEAD~2');
    const run = runPackScript('../../scripts/__tests__/push-pr-head', {
      cwd,
      inputs: { INPUTS_PR: JSON.stringify(forgePrRecord()) },
      preload: 'Bun.sleepSync = () => {};',
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('refused');
  });

  it('refuses when two remotes claim the same repository', () => {
    const cwd = gitCheckout({}, track);
    git(cwd, 'remote', 'add', 'mirror', `git@${PR.repo.host}:${PR.repo.path}.git`);
    const run = runPackScript('../../scripts/__tests__/push-pr-head', { cwd, inputs: { INPUTS_PR: JSON.stringify(forgePrRecord()) } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('ambiguous');
  });
});

describe.each(['build-queue', 'ship'])('%s continuation checkout', entry => {
  const checkout = `${entry}/scripts/checkout`;
  const inputs = { INPUTS_ITEM: JSON.stringify(PR), INPUTS_CONTINUES: String(PR.number), INPUTS_REF: JSON.stringify(PR), INPUTS_PULL_REQUEST: String(PR.number) };

  it.each([false, true])('starts exactly at the PR head or refuses divergent local history (divergent=%s)', divergent => {
    const cwd = gitCheckout({}, track);
    const prHead = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'push', '-q', 'upstream', 'feature');
    git(cwd, 'checkout', '-q', '-b', 'archon/build-test', 'dev');
    if (divergent) {
      writeFileSync(join(cwd, 'base-only.txt'), 'base advancement');
      git(cwd, 'add', 'base-only.txt');
      git(cwd, 'commit', '-q', '-m', 'advance base');
    }
    const initial = git(cwd, 'rev-parse', 'HEAD');
    expect(spawnSync('git', ['merge-base', '--is-ancestor', prHead, 'HEAD'], { cwd }).status).toBe(1);
    const prepared = runPackScript(checkout, {
      cwd, inputs, source: divergent ? 'forge' : 'gh',
      forge: { kind: 'fake', response: forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: prHead }), title: '', body: '' }) },
    });
    if (divergent) expect(prepared.gh).toEqual([]);
    if (divergent) {
      expect(prepared.code).not.toBe(0);
      expect(prepared.stderr).toContain('cannot fast-forward exactly');
      expect(git(cwd, 'rev-parse', 'HEAD')).toBe(initial);
      expect(git(cwd, 'ls-remote', 'upstream', 'refs/heads/feature').split(/\s+/)[0]).toBe(prHead);
      return;
    }
    expect({ code: prepared.code, stderr: prepared.stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(prepared.stdout)).toEqual({ head: prHead });
    expect(git(cwd, 'branch', '--show-current')).toBe('archon/build-test');
    git(cwd, 'merge-base', '--is-ancestor', prHead, 'HEAD');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(prHead);
    const published = runPackScript('pr/scripts/publish-pr', {
      cwd,
      gh: { pr: { headRefOid: git(cwd, 'rev-parse', 'HEAD') } },
      inputs: { INPUTS_PULL_REQUEST: String(PR.number), INPUTS_HEAD_REPO: JSON.stringify(PR.repo), INPUTS_EXISTING: String(PR.number), INPUTS_REPO: JSON.stringify(PR.repo) },
    });
    expect({ code: published.code, stderr: published.stderr }).toEqual({ code: 0, stderr: '' });
    expect(published.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(git(cwd, 'ls-remote', 'upstream', 'refs/heads/feature').split(/\s+/)[0]).toBe(git(cwd, 'rev-parse', 'HEAD'));
  });

  it('does nothing on a first round without reading a forge or requiring a repository', () => {
    const run = runPackScript(checkout, { inputs: { INPUTS_CONTINUES: 'null', INPUTS_PULL_REQUEST: 'null' } });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ head: null });
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
  });

  it.each(['conflict', 'missing', 'closed', 'fork'] as const)('refuses %s before delivery without changing the remote', mode => {
    const cwd = gitCheckout({ conflict: mode === 'conflict' }, track);
    const prHead = git(cwd, 'rev-parse', 'HEAD');
    if (mode !== 'missing') git(cwd, 'push', '-q', 'upstream', 'feature');
    git(cwd, 'checkout', '-q', '-b', 'archon/build-test', 'dev');
    const run = runPackScript(checkout, { cwd, inputs, gh: { pr: {
      ...(mode === 'closed' ? { state: 'CLOSED' } : {}),
      ...(mode === 'fork' ? { headRepositoryOwner: { login: 'fork' } } : {}),
    } } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(mode === 'conflict' ? 'cannot fast-forward exactly' : mode === 'missing' ? 'fetch' : mode === 'fork' ? 'maintainer edits' : 'must be open with a head');
    expect(git(cwd, 'branch', '--show-current')).toBe('archon/build-test');
    if (mode === 'conflict') {
      expect(git(cwd, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    }
    expect(git(cwd, 'ls-remote', 'upstream', 'refs/heads/feature').split(/\s+/)[0]).toBe(mode === 'missing' ? '' : prHead);
  });

  it('preserves a remote advancement after preparation by refusing normal publication', () => {
    const cwd = gitCheckout({}, track);
    git(cwd, 'push', '-q', 'upstream', 'feature');
    git(cwd, 'checkout', '-q', '-b', 'archon/build-test', 'dev');
    expect(runPackScript(checkout, { cwd, inputs }).code).toBe(0);
    git(cwd, 'checkout', '-q', 'feature');
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'remote advanced');
    const advanced = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'push', '-q', 'upstream', 'feature');
    git(cwd, 'checkout', '-q', 'archon/build-test');
    const published = runPackScript('../../scripts/__tests__/push-pr-head', { cwd, inputs: { INPUTS_PR: JSON.stringify(forgePrRecord()) }, preload: 'Bun.sleepSync = () => {};' });
    expect(published.code).not.toBe(0);
    expect(published.stderr).toContain('refused');
    expect(git(cwd, 'ls-remote', 'upstream', 'refs/heads/feature').split(/\s+/)[0]).toBe(advanced);
  });
});

describe('head operation transport', () => {
  it.each(['build-queue/scripts/checkout', 'ship/scripts/checkout', '../../scripts/__tests__/push-pr-head'])('refuses credentialed HTTP before %s', script => {
    const cwd = gitCheckout({}, track);
    git(cwd, 'push', '-q', 'upstream', 'feature');
    const before = git(cwd, 'rev-parse', 'HEAD');
    const url = `http://user:secret@${PR.repo.host}/${PR.repo.path}.git`;
    const bare = git(cwd, 'remote', 'get-url', 'upstream');
    git(cwd, 'config', `url.${bare}.insteadOf`, url);
    git(cwd, 'remote', 'set-url', 'upstream', url);
    const run = runPackScript(script, { cwd, inputs: {
      INPUTS_ITEM: JSON.stringify(PR), INPUTS_CONTINUES: String(PR.number),
      INPUTS_REF: JSON.stringify(PR), INPUTS_PULL_REQUEST: String(PR.number),
      INPUTS_PR: JSON.stringify(forgePrRecord()),
    } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('requires encrypted transport');
    expect(run.stderr).not.toContain('secret');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(cwd, 'ls-remote', 'upstream', 'refs/heads/feature').split(/\s+/)[0]).toBe(before);
  });
});

describe('standalone continuation identity', () => {
  it('refuses a different resolved number before reading the forge', () => {
    const run = runPackScript('ship/scripts/checkout', { inputs: {
      INPUTS_PULL_REQUEST: String(PR.number + 1), INPUTS_REF: JSON.stringify(PR),
    } });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('differs from the continuation');
    expect(run.gh).toEqual([]);
    expect(run.forge).toEqual([]);
  });

  it('refuses ambiguous fork destinations for both preparation and publication', () => {
    const cwd = gitCheckout({}, track);
    git(cwd, 'remote', 'add', 'mirror', `git@${PR.repo.host}:${PR.repo.path}.git`);
    const baseRepo = { host: PR.repo.host, path: 'canonical/repo' };
    const pr = forgePrRecord({ repo: baseRepo, maintainer_can_modify: true });
    const before = git(cwd, 'rev-parse', 'HEAD');
    const prepared = runPackScript('ship/scripts/checkout', {
      cwd, source: 'forge',
      inputs: { INPUTS_PULL_REQUEST: String(PR.number), INPUTS_REF: JSON.stringify({ repo: baseRepo, number: PR.number }) },
      forge: { kind: 'fake', response: forgeOperation('pr.view', { pr, title: '', body: '' }) },
    });
    const published = runPackScript('../../scripts/__tests__/push-pr-head', {
      cwd, inputs: { INPUTS_PR: JSON.stringify(pr) },
    });
    for (const result of [prepared, published]) {
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('ambiguous');
    }
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(cwd, 'ls-remote', 'upstream', 'refs/heads/feature')).toBe('');
  });

  it.each([true, false])('prepares an editable fork (configured remote=%s)', configured => {
    const cwd = gitCheckout({}, track);
    const head = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'push', '-q', 'upstream', 'feature');
    git(cwd, 'checkout', '-q', '-b', 'archon/standalone', 'dev');
    if (!configured) git(cwd, 'remote', 'remove', 'upstream');
    const baseRepo = { host: PR.repo.host, path: 'canonical/repo' };
    const run = runPackScript('ship/scripts/checkout', {
      cwd, source: 'forge',
      inputs: { INPUTS_PULL_REQUEST: String(PR.number), INPUTS_REF: JSON.stringify({ repo: baseRepo, number: PR.number }) },
      forge: { kind: 'fake', response: forgeOperation('pr.view', { pr: forgePrRecord({ repo: baseRepo, head_revision: head, maintainer_can_modify: true }), title: '', body: '' }) },
    });
    expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' });
    git(cwd, 'merge-base', '--is-ancestor', head, 'HEAD');
    expect(git(cwd, 'branch', '--show-current')).toBe('archon/standalone');
    expect(run.gh).toEqual([]);
    expect(JSON.parse(run.forgeRequests[0] ?? '')).toEqual({ selector: { kind: 'number', ref: { repo: baseRepo, number: PR.number } } });
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'delivery');
    const published = runPackScript('../../scripts/__tests__/push-pr-head', {
      cwd, inputs: { INPUTS_PR: JSON.stringify(forgePrRecord({ repo: baseRepo })) },
    });
    expect({ code: published.code, stderr: published.stderr }).toEqual({ code: 0, stderr: '' });
    expect(git(cwd, 'ls-remote', `https://${PR.repo.host}/${PR.repo.path}.git`, 'refs/heads/feature').split(/\s+/)[0]).toBe(git(cwd, 'rev-parse', 'HEAD'));
  });
});

describe('prune-scratch', () => {
  it('removes a symlinked scratch directory as a link, leaving its target', () => {
    const cwd = gitCheckout({}, track);
    const artifacts = track(mkdtempSync(join(tmpdir(), 'archon-scratch-')));
    const target = track(mkdtempSync(join(tmpdir(), 'archon-scratch-target-')));
    writeFileSync(join(target, 'keep.txt'), 'kept');
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(target, join(artifacts, 'scratch'), 'junction');

    const run = spawnSync(process.execPath, [join(import.meta.dir, '../../workflows/sdlc/review/scripts/prune-scratch.ts')], {
      cwd,
      env: { ...process.env, ARTIFACTS_DIR: artifacts, INPUTS_LENS: '' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(existsSync(join(artifacts, 'scratch'))).toBe(false);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  it("removes the run's scratch worktrees and nothing else", () => {
    const cwd = gitCheckout({}, track);
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
