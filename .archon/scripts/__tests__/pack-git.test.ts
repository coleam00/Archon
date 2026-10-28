/**
 * The pack's git steps, against real repositories: which remote holds a repository
 * (by URL, never by name), publish-pr's push, the base-sync verification,
 * and reviewer scratch cleanup.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { urlRepo } from '../../workflows/sdlc/.shared/remote';
import { scratchDir } from '../../workflows/sdlc/.shared/scratch';
import { PR, forgePrRecord, gitCheckout, packScriptRunner } from './deliver-checks-harness';

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

describe('the default branch snapshot', () => {
  it('returns no maintainers for a confirmed absent policy file', () => {
    const cwd = gitCheckout({}, track);
    const run = spawnSync(process.execPath, ['-e', `
      import { readMaintainers } from ${JSON.stringify(new URL('../../workflows/sdlc/.shared/maintainers.ts', import.meta.url).href)};
      console.log(JSON.stringify([...readMaintainers(${JSON.stringify(PR.repo)})]));
    `], { cwd, encoding: 'utf8' });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(run.stdout)).toEqual([]);
  });

  it.each(['before fetch', 'at fetch'])('fetches fresh objects when the remote advances %s without changing tracking refs or FETCH_HEAD', timing => {
    const cwd = gitCheckout({}, track);
    const stale = git(cwd, 'rev-parse', 'refs/remotes/upstream/dev');
    git(cwd, 'fetch', '-q', 'upstream', 'dev');
    const fetchHead = readFileSync(join(cwd, '.git/FETCH_HEAD'), 'utf8');
    const writer = track(mkdtempSync(join(tmpdir(), 'archon-default-writer-')));
    git(writer, 'clone', '-q', git(cwd, 'remote', 'get-url', 'upstream'), '.');
    git(writer, 'config', 'user.email', 'test@example.com');
    git(writer, 'config', 'user.name', 'Test');
    mkdirSync(join(writer, '.archon/sdlc/policy'), { recursive: true });
    writeFileSync(join(writer, '.archon/sdlc/policy/maintainers.json'), '["NewMaintainer"]');
    git(writer, 'add', '.archon/sdlc/policy/maintainers.json');
    git(writer, 'commit', '-q', '-m', 'new maintainer');
    if (timing === 'before fetch') git(writer, 'push', '-q', 'origin', 'dev');
    const fresh = git(writer, 'rev-parse', 'HEAD');

    const run = spawnSync(process.execPath, ['-e', `
      import { fetchDefaultBranch } from ${JSON.stringify(new URL('../../workflows/sdlc/.shared/remote.ts', import.meta.url).href)};
      import { readMaintainers } from ${JSON.stringify(new URL('../../workflows/sdlc/.shared/maintainers.ts', import.meta.url).href)};
      const nativeGit = Bun.spawnSync.bind(Bun);
      let advance = ${JSON.stringify(timing === 'at fetch')};
      Bun.spawnSync = (argv, options) => {
        if (advance && argv[0] === 'git' && argv[1] === 'fetch') {
          advance = false;
          const pushed = nativeGit(['git', '-C', ${JSON.stringify(writer)}, 'push', '-q', 'origin', 'dev']);
          if (pushed.exitCode !== 0) throw new Error(pushed.stderr.toString());
        }
        return nativeGit(argv, options);
      };
      const repo = ${JSON.stringify(PR.repo)};
      console.log(JSON.stringify({ base: fetchDefaultBranch(repo), maintainers: [...readMaintainers(repo)] }));
    `], { cwd, encoding: 'utf8' });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(run.stdout)).toEqual({ base: { branch: 'dev', sha: fresh }, maintainers: ['newmaintainer'] });
    expect(git(cwd, 'rev-parse', 'refs/remotes/upstream/dev')).toBe(stale);
    expect(readFileSync(join(cwd, '.git/FETCH_HEAD'), 'utf8')).toBe(fetchHead);
    expect(git(cwd, 'for-each-ref', 'refs/archon')).toBe('');
  });

  it.each(['switch before fetch', 'switch after fetch', 'advance after fetch', 'missing default after fetch'])(
    'binds the default branch identity to the fetched snapshot: %s', change => {
      const cwd = gitCheckout({}, track);
      const remote = git(cwd, 'remote', 'get-url', 'upstream');
      const stale = git(cwd, 'rev-parse', 'refs/remotes/upstream/dev');
      const fresh = git(cwd, 'rev-parse', 'HEAD');
      git(cwd, 'push', '-q', 'upstream', 'HEAD:refs/heads/main');
      git(cwd, 'fetch', '-q', 'upstream', 'dev');
      const fetchHead = readFileSync(join(cwd, '.git/FETCH_HEAD'), 'utf8');
      const run = spawnSync(process.execPath, ['-e', `
        import { fetchDefaultBranch } from ${JSON.stringify(new URL('../../workflows/sdlc/.shared/remote.ts', import.meta.url).href)};
        const nativeGit = Bun.spawnSync.bind(Bun);
        const change = ${JSON.stringify(change)};
        const mutate = () => {
          const argv = change === 'advance after fetch'
            ? ['git', 'push', '-q', ${JSON.stringify(remote)}, 'HEAD:refs/heads/dev']
            : ['git', '--git-dir', ${JSON.stringify(remote)}, 'symbolic-ref', 'HEAD',
                change === 'missing default after fetch' ? 'refs/heads/missing' : 'refs/heads/main'];
          const changed = nativeGit(argv);
          if (changed.exitCode !== 0) throw new Error(changed.stderr.toString());
        };
        Bun.spawnSync = (argv, options) => {
          if (argv[0] === 'git' && argv[1] === 'fetch' && change === 'switch before fetch') mutate();
          const result = nativeGit(argv, options);
          if (argv[0] === 'git' && argv[1] === 'fetch' && change !== 'switch before fetch') mutate();
          return result;
        };
        console.log(JSON.stringify(fetchDefaultBranch(${JSON.stringify(PR.repo)})));
      `], { cwd, encoding: 'utf8' });
      if (change === 'switch before fetch') {
        expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
        expect(JSON.parse(run.stdout)).toEqual({ branch: 'main', sha: fresh });
        expect(git(cwd, 'ls-remote', 'upstream', 'refs/heads/dev')).toContain(stale);
      } else {
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain(change === 'missing default after fetch'
          ? 'reports no default branch' : 'default branch changed during fetch');
        expect(run.stdout).toBe('');
      }
      expect(git(cwd, 'rev-parse', 'refs/remotes/upstream/dev')).toBe(stale);
      expect(readFileSync(join(cwd, '.git/FETCH_HEAD'), 'utf8')).toBe(fetchHead);
      expect(git(cwd, 'for-each-ref', 'refs/archon')).toBe('');
    }
  );
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

describe('prune-scratch', () => {
  it('removes a symlinked scratch directory as a link, leaving its target', () => {
    const cwd = gitCheckout({}, track);
    const artifacts = track(mkdtempSync(join(tmpdir(), 'archon-scratch-')));
    const target = track(mkdtempSync(join(tmpdir(), 'archon-scratch-target-')));
    writeFileSync(join(target, 'keep.txt'), 'kept');
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    mkdirSync(join(artifacts, '.archon'));
    symlinkSync(target, scratchDir(artifacts, ''), 'junction');

    const run = spawnSync(process.execPath, [join(import.meta.dir, '../../workflows/sdlc/review/scripts/prune-scratch.ts')], {
      cwd,
      env: { ...process.env, ARTIFACTS_DIR: artifacts, INPUTS_LENS: '' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(existsSync(scratchDir(artifacts, ''))).toBe(false);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  it("removes the run's scratch worktrees and nothing else", () => {
    const cwd = gitCheckout({}, track);
    const artifacts = track(mkdtempSync(join(tmpdir(), 'archon-scratch-')));
    const scratch = scratchDir(artifacts, 'code');
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
    expect(existsSync(scratchDir(artifacts, ''))).toBe(false);
    expect(existsSync(join(cwd, 'untracked.txt'))).toBe(true);
  });
});
