import { describe, expect, mock, test } from 'bun:test';
import type { Codebase } from '@archon/core';

mock.module('@archon/paths', () => ({
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/tmp/test-workspaces/${owner}/${repo}/source`
  ),
}));

const mockUpdateCodebase = mock(async () => undefined);
const mockFindCodebaseByRepoUrl = mock(
  async (): Promise<Pick<Codebase, 'id' | 'repository_url' | 'default_cwd' | 'name'> | null> => null
);

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  updateCodebase: mockUpdateCodebase,
}));

import { getOrCreateCodebaseForRepo } from './registration';

const gitlabUrl = 'https://gitlab.example.com';

describe('getOrCreateCodebaseForRepo', () => {
  test('refuses ambiguous stale checkout repair for a bare project name', async () => {
    const existing = {
      id: 'bare-project',
      name: 'local-api',
      default_cwd: '/repos/worktrees/old',
      repository_url: 'https://example.com/testuser/testrepo',
    };
    mockFindCodebaseByRepoUrl.mockResolvedValueOnce(existing);
    mockUpdateCodebase.mockClear();
    await expect(getOrCreateCodebaseForRepo(gitlabUrl, 'testuser/testrepo')).rejects.toThrow(
      '/update-project'
    );
    expect(existing.default_cwd).toBe('/repos/worktrees/old');
    expect(mockUpdateCodebase).not.toHaveBeenCalled();
  });

  test('stale suffixed checkout repair keeps its allocated project identity', async () => {
    mockFindCodebaseByRepoUrl.mockResolvedValueOnce({
      id: 'allocated',
      name: 'testuser/testrepo-2',
      default_cwd: '/tmp/test-workspaces/testuser/testrepo-2/worktrees/old',
      repository_url: 'https://example.com/testuser/testrepo',
    });
    const result = await getOrCreateCodebaseForRepo(gitlabUrl, 'testuser/testrepo');
    expect(result.repoPath).toBe('/tmp/test-workspaces/testuser/testrepo-2/source');
    expect(result.codebase.default_cwd).toBe(result.repoPath);
    expect(mockUpdateCodebase).toHaveBeenCalledWith(expect.objectContaining({ id: 'allocated' }), {
      default_cwd: result.repoPath,
    });
  });

  test('refuses legacy nested repair without changing its storage identity', async () => {
    const existing = {
      id: 'nested',
      name: 'group/subgroup/repo',
      default_cwd: '/tmp/test-workspaces/group/subgroup/repo/worktrees/old',
      repository_url: 'https://gitlab.example.com/group/subgroup/repo',
    };
    mockFindCodebaseByRepoUrl.mockResolvedValueOnce(existing);
    mockUpdateCodebase.mockClear();
    await expect(getOrCreateCodebaseForRepo(gitlabUrl, 'group/subgroup/repo')).rejects.toThrow(
      '/update-project'
    );
    expect(existing.default_cwd).toBe('/tmp/test-workspaces/group/subgroup/repo/worktrees/old');
    expect(existing.name).toBe('group/subgroup/repo');
    expect(mockUpdateCodebase).not.toHaveBeenCalled();
  });
});
