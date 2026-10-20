import { describe, expect, mock, test } from 'bun:test';
import type { Codebase } from '@archon/core';

mock.module('@archon/paths', () => ({
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/tmp/test-workspaces/${owner}/${repo}/source`
  ),
}));

const mockUpdateCodebase = mock(async () => {});
const mockFindCodebaseByRepoUrl = mock(
  async (): Promise<Pick<Codebase, 'id' | 'repository_url' | 'default_cwd' | 'name'> | null> => null
);

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByRepoUrl: mockFindCodebaseByRepoUrl,
  updateCodebase: mockUpdateCodebase,
}));

import { getOrCreateCodebaseForRepo } from './registration';

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
    await expect(
      getOrCreateCodebaseForRepo('https://github.com', 'testuser', 'testrepo')
    ).rejects.toThrow('/update-project');
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
    const result = await getOrCreateCodebaseForRepo('https://github.com', 'testuser', 'testrepo');
    expect(result.repoPath).toBe('/tmp/test-workspaces/testuser/testrepo-2/source');
    expect(result.codebase.default_cwd).toBe(result.repoPath);
    expect(mockUpdateCodebase).toHaveBeenCalledWith(expect.objectContaining({ id: 'allocated' }), {
      default_cwd: result.repoPath,
    });
  });

  test('looks the repository up under the configured GitHub web URL', async () => {
    mockFindCodebaseByRepoUrl.mockResolvedValueOnce({
      id: 'ghe',
      name: 'acme/api',
      default_cwd: '/tmp/test-workspaces/acme/api/source',
      repository_url: 'https://ghe.example/acme/api',
    });
    await getOrCreateCodebaseForRepo('https://ghe.example', 'acme', 'api');
    expect(mockFindCodebaseByRepoUrl).toHaveBeenLastCalledWith('https://ghe.example/acme/api');
  });
});
