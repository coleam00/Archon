/** Branch names and worktree paths the provider derives from a request and repo config. */
import { TEST_ARCHON_HOME, realProjectWorktreesLayout } from './worktree-test-fixture';
import { describe, test, expect } from 'bun:test';
import { join, resolve, relative } from 'node:path';
import * as git from '@archon/git';
import { getProjectWorktreesPath } from '@archon/paths';
import type { IsolationRequest } from '../types';
import { WorktreeProvider } from './worktree';

const provider = new WorktreeProvider();
const base = { codebaseId: 'cb-123', canonicalRepoPath: git.toRepoPath('/workspace/repo') };
const issue = (canonicalRepoPath: string): IsolationRequest => ({
  ...base,
  canonicalRepoPath: git.toRepoPath(canonicalRepoPath),
  workflowType: 'issue',
  identifier: '42',
});

describe('generateBranchName', () => {
  test.each<[string, IsolationRequest, string]>([
    ['issue-N for issues', { ...base, workflowType: 'issue', identifier: '42' }, 'archon/issue-42'],
    [
      'review-N for reviews',
      { ...base, workflowType: 'review', identifier: '456' },
      'archon/review-456',
    ],
    [
      'the PR branch itself for same-repo PRs',
      {
        ...base,
        workflowType: 'pr',
        identifier: '123',
        prBranch: git.toBranchName('feature/auth'),
        isForkPR: false,
      },
      'feature/auth',
    ],
    [
      'pr-N-review for fork PRs',
      {
        ...base,
        workflowType: 'pr',
        identifier: '123',
        prBranch: git.toBranchName('feature/auth'),
        isForkPR: true,
      },
      'archon/pr-123-review',
    ],
    [
      'a slug of the task identifier',
      { ...base, workflowType: 'task', identifier: 'Add Dark Mode!!!' },
      'archon/task-add-dark-mode',
    ],
    [
      'an explicit task branch verbatim',
      {
        ...base,
        workflowType: 'task',
        identifier: 'archon/task-fix-2926',
        taskBranch: { kind: 'new', branch: git.toBranchName('archon/task-fix-2926') },
      },
      'archon/task-fix-2926',
    ],
  ])('generates %s', (_label, input, expected) => {
    expect(provider.generateBranchName(input)).toBe(expected);
  });

  test('hashes a thread identifier into a stable, distinct thread-{hash}', () => {
    const thread = (identifier: string): string =>
      provider.generateBranchName({ ...base, workflowType: 'thread', identifier });
    expect(thread('C123:1234567890.123456')).toMatch(/^archon\/thread-[a-f0-9]{8}$/);
    expect(thread('thread-1')).toBe(thread('thread-1'));
    expect(thread('thread-1')).not.toBe(thread('thread-2'));
  });
});

describe('getWorktreePath', () => {
  const pathFor = (input: IsolationRequest): string =>
    provider.getWorktreePath(input, provider.generateBranchName(input));
  const localPath = (repo: string, branch: string): string =>
    join(TEST_ARCHON_HOME, 'workspaces', '_local', repo, 'worktrees', branch);

  test('the test home preserves the production project worktree layout', () => {
    expect(relative(TEST_ARCHON_HOME, getProjectWorktreesPath('owner', 'repo'))).toBe(
      realProjectWorktreesLayout
    );
  });

  test('resolves a repo outside the workspaces tree to _local/<basename>', () => {
    expect(pathFor(issue('/home/dev/projects/repo'))).toBe(localPath('repo', 'archon/issue-42'));
    // A single-segment path resolves the same way.
    expect(pathFor(issue('/repo'))).toBe(localPath('repo', 'archon/issue-42'));
  });

  test.each([
    ['Windows-style', '\\owner\\repo'],
    ['mixed', '/owner\\repo'],
  ])('yields owner/repo for %s separators under workspaces/', (_label, suffix) => {
    const path = pathFor(issue(`${join(TEST_ARCHON_HOME, 'workspaces')}${suffix}`));
    expect(path).toContain('owner');
    expect(path).toContain('repo');
    expect(path).toContain('issue-42');
  });

  test('throws for a degenerate repo path with no basename', () => {
    expect(() => pathFor(issue('/'))).toThrow('Cannot derive a project identity');
  });
});

describe('worktree.path repo-local override', () => {
  const baseRequest: IsolationRequest = {
    codebaseId: 'cb-local-1',
    codebaseName: 'owner/myapp',
    canonicalRepoPath: git.toRepoPath('/Users/dev/Projects/myapp'),
    workflowType: 'task',
    identifier: 'add-feature',
  };
  const branch = provider.generateBranchName(baseRequest);
  const defaultPath = join(TEST_ARCHON_HOME, 'workspaces', 'owner', 'myapp', 'worktrees', branch);

  test('uses <repoRoot>/<path>/<branch> when worktree.path is set', () => {
    expect(provider.getWorktreePath(baseRequest, branch, { path: '.worktrees' })).toBe(
      join('/Users/dev/Projects/myapp', '.worktrees', branch)
    );
    expect(provider.getWorktreePath(baseRequest, branch, { path: '.archon/worktrees' })).toBe(
      join('/Users/dev/Projects/myapp', '.archon/worktrees', branch)
    );
  });

  test('an absent, empty or blank path keeps the workspace-scoped default', () => {
    for (const config of [undefined, null, { path: '' }, { path: '   ' }]) {
      expect(provider.getWorktreePath(baseRequest, branch, config)).toBe(defaultPath);
    }
    expect(provider.getWorktreePath(baseRequest, branch)).toBe(defaultPath);
  });

  test('override wins even when repo lives under ~/.archon/workspaces/', () => {
    const managed: IsolationRequest = {
      codebaseId: 'cb-local-2',
      codebaseName: 'owner/repo',
      canonicalRepoPath: git.toRepoPath(join(TEST_ARCHON_HOME, 'workspaces', 'owner', 'repo')),
      workflowType: 'task',
      identifier: 'my-task',
    };
    const managedBranch = provider.generateBranchName(managed);
    expect(provider.getWorktreePath(managed, managedBranch, { path: 'worktrees-local' })).toBe(
      join(TEST_ARCHON_HOME, 'workspaces', 'owner', 'repo', 'worktrees-local', managedBranch)
    );
  });

  test('rejects an absolute worktree.path with a clear error', () => {
    const absolute = (): string =>
      provider.getWorktreePath(baseRequest, branch, { path: '/tmp/worktrees' });
    expect(absolute).toThrow(/must be relative to the repo root/);
    expect(absolute).toThrow(/omit worktree.path/);
  });

  test.each(['../worktrees', '..', 'nested/../../escape'])(
    'rejects %s for escaping the repo root',
    path => {
      expect(() => provider.getWorktreePath(baseRequest, branch, { path })).toThrow(
        /must stay within the repo/
      );
    }
  );

  // A drive-relative path such as `Z:worktrees` is not absolute on Windows and has
  // no `..` segment, so only the resolved containment check sees it leave the repo.
  // On POSIX the same string is an ordinary directory name inside the repo.
  test('a drive-relative worktree.path on another drive resolves outside the repo on Windows', () => {
    const repoDrive = resolve('/').slice(0, 1).toUpperCase();
    const otherDrive = repoDrive === 'Z' ? 'Y' : 'Z';
    const config = { path: `${otherDrive}:worktrees` };
    if (process.platform === 'win32') {
      expect(() => provider.getWorktreePath(baseRequest, branch, config)).toThrow(
        /resolves outside the repo root/
      );
    } else {
      expect(provider.getWorktreePath(baseRequest, branch, config)).toBe(
        join('/Users/dev/Projects/myapp', `${otherDrive}:worktrees`, branch)
      );
    }
  });
});
