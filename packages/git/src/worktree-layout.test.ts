import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { saveEnvironment } from './test-fixtures/environment';
import { clearLogger, git, mockLogger, repo } from './test-fixtures/git-harness';

describe('git utilities', () => {
  beforeEach(clearLogger);
  let restoreEnvironment: () => void;
  beforeEach(() => {
    restoreEnvironment = saveEnvironment(
      'WORKTREE_BASE',
      'WORKSPACE_PATH',
      'HOME',
      'ARCHON_HOME',
      'ARCHON_DOCKER'
    );
    delete process.env.WORKTREE_BASE;
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_HOME;
    delete process.env.ARCHON_DOCKER;
  });
  afterEach(() => restoreEnvironment());
  describe('getWorktreeBase', () => {
    test('returns workspace-scoped base for a local non-workspace repo (via path fallback)', () => {
      const result = git.getWorktreeBase(repo('/workspace/my-repo'));
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'my-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('uses ARCHON_HOME for the workspace-scoped base (local non-Docker)', () => {
      process.env.ARCHON_HOME = '/custom/archon';
      const result = git.getWorktreeBase(repo('/workspace/my-repo'));
      expect(result).toEqual({
        base: join('/custom/archon', 'workspaces', '_local', 'my-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('uses the Docker archon home for the workspace-scoped base', () => {
      process.env.ARCHON_DOCKER = 'true';
      const result = git.getWorktreeBase(repo('/workspace/my-repo'));
      expect(result).toEqual({
        base: join('/', '.archon', 'workspaces', '_local', 'my-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('returns workspace-scoped path when repo is already under workspaces/', () => {
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      const repoPath = join(workspacesPath, 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repo(repoPath));
      expect(result).toEqual({
        base: join(workspacesPath, 'acme', 'widget', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('does not read owner/repo from a sibling that only shares the workspaces prefix', () => {
      const lookalike = join(homedir(), '.archon', 'workspaces-old', 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repo(lookalike));
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'source', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('workspace-scoped path honors ARCHON_HOME override', () => {
      process.env.ARCHON_HOME = join('/', 'custom', 'archon');
      const repoPath = join('/', 'custom', 'archon', 'workspaces', 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repo(repoPath));
      expect(result).toEqual({
        base: join('/', 'custom', 'archon', 'workspaces', 'acme', 'widget', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('uses codebaseName to resolve workspace-scoped path for a local repo', () => {
      const localRepoPath = '/Users/rasmus/Projects/sasha-demo';
      const result = git.getWorktreeBase(repo(localRepoPath), 'Widinglabs/sasha-demo');
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', 'Widinglabs', 'sasha-demo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('codebaseName takes priority over workspaces path detection', () => {
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      const repoPath = join(workspacesPath, 'old-owner', 'old-repo', 'source');
      const result = git.getWorktreeBase(repo(repoPath), 'new-owner/new-repo');
      expect(result).toEqual({
        base: join(workspacesPath, 'new-owner', 'new-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('ignores invalid codebaseName and falls back to _local/<basename>', () => {
      const result = git.getWorktreeBase(repo('/local/repo'), 'invalid-no-slash');
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('ignores SSH-URL-shaped codebaseName (contains ":" / "@") and falls back to _local', () => {
      const result = git.getWorktreeBase(
        repo('/srv/projects/widget-app'),
        'git@git.example.net:acme/widget-app'
      );
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'widget-app', 'worktrees'),
        layout: 'workspace-scoped',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { codebaseName: 'git@git.example.net:acme/widget-app' },
        'worktree.invalid_codebase_name_format'
      );
      // Check only the path below homedir — on Windows the home directory
      // itself contains ":" in the drive letter (e.g. C:\Users\...).
      const relativeToHome = result.base.slice(homedir().length);
      expect(relativeToHome).not.toContain(':');
      expect(relativeToHome).not.toContain('@');
    });

    test('resolves single-segment checkout paths via _local fallback (no throw)', () => {
      const result = git.getWorktreeBase(repo('/workspace'));
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'workspace', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('throws for a degenerate repo path with no usable basename', () => {
      expect(() => git.getWorktreeBase(repo('/'))).toThrow('Cannot derive a project identity');
    });

    test('repoLocal override wins over workspace-scoped default', () => {
      const repoPath = '/Users/rasmus/Projects/myapp';
      const result = git.getWorktreeBase(repo(repoPath), undefined, { repoLocal: '.worktrees' });
      expect(result).toEqual({
        base: join(repoPath, '.worktrees'),
        layout: 'repo-local',
      });
    });

    test('repoLocal override wins even for repos under workspaces/', () => {
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      const repoPath = join(workspacesPath, 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repo(repoPath), 'acme/widget', { repoLocal: '.wt' });
      expect(result).toEqual({
        base: join(repoPath, '.wt'),
        layout: 'repo-local',
      });
    });
  });

  describe('isProjectScopedWorktreeBase (deprecated)', () => {
    test('returns true for a local non-workspace path (new two-layout model)', () => {
      expect(git.isProjectScopedWorktreeBase(repo('/workspace/my-repo'))).toBe(true);
    });
  });
});
