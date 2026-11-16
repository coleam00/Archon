/** Reading existing worktrees: healthCheck. */
import { resetWorktreeMocks, worktreeExistsSpy } from './worktree-test-fixture';
import { describe, test, expect, beforeEach } from 'bun:test';
import * as git from '@archon/git';
import { WorktreeProvider } from './worktree';

const provider = new WorktreeProvider();
const FEATURE_PATH = git.toWorktreePath('/workspace/worktrees/repo/feature-auth');

beforeEach(resetWorktreeMocks);

describe('healthCheck', () => {
  test('reports whether the worktree exists', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    expect(await provider.healthCheck(FEATURE_PATH)).toBe(true);
    worktreeExistsSpy.mockResolvedValue(false);
    expect(await provider.healthCheck('/workspace/worktrees/repo/nonexistent')).toBe(false);
  });

  test('propagates I/O errors from worktreeExists (permission denied)', async () => {
    // worktreeExists throws for permission errors (only returns false for ENOENT)
    worktreeExistsSpy.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied, access'), { code: 'EACCES' })
    );

    await expect(provider.healthCheck(FEATURE_PATH)).rejects.toThrow('EACCES');
  });
});
