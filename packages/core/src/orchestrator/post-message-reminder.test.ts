import { mock, describe, test, expect, beforeEach } from 'bun:test';
import type { IPlatformAdapter } from '../types';
import type { Codebase } from '../types';

const mockGetCurrentBranch = mock(() => Promise.resolve(null as string | null));
const mockCountCommitsAhead = mock(() => Promise.resolve(0));
const mockHasUncommittedChanges = mock(() => Promise.resolve(false));

mock.module('@archon/git', () => ({
  getCurrentBranch: mockGetCurrentBranch,
  countCommitsAhead: mockCountCommitsAhead,
  hasUncommittedChanges: mockHasUncommittedChanges,
  toRepoPath: (p: string) => p,
}));

mock.module('@archon/paths', () => ({
  getArchonWorkspacesPath: () => '/home/test/.archon/workspaces',
  createLogger: () => ({
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
    info: mock(() => undefined),
  }),
}));

import { reportUnpushedWorkInSource } from './post-message-reminder';

function makeManagedCodebase(overrides: Partial<Codebase> = {}): Codebase {
  return {
    id: 'cb-1',
    name: 'owner/repo',
    default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    repository_url: null,
    default_branch: 'main',
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makePlatform(hasSendStructuredEvent = true): IPlatformAdapter {
  const sendStructuredEvent = hasSendStructuredEvent ? mock(() => Promise.resolve()) : undefined;
  return { sendStructuredEvent } as unknown as IPlatformAdapter;
}

describe('reportUnpushedWorkInSource', () => {
  beforeEach(() => {
    mockGetCurrentBranch.mockReset();
    mockCountCommitsAhead.mockReset();
    mockHasUncommittedChanges.mockReset();
  });

  test('does nothing when platform has no sendStructuredEvent', async () => {
    const platform = makePlatform(false);
    await reportUnpushedWorkInSource('conv-1', makeManagedCodebase(), platform);
    expect(mockGetCurrentBranch).not.toHaveBeenCalled();
  });

  test('does nothing for non-managed repo (path outside workspaces/)', async () => {
    const codebase = makeManagedCodebase({ default_cwd: '/home/user/myrepo' });
    const platform = makePlatform();
    await reportUnpushedWorkInSource('conv-1', codebase, platform);
    expect(mockGetCurrentBranch).not.toHaveBeenCalled();
  });

  test('does nothing when getCurrentBranch returns null (detached HEAD)', async () => {
    mockGetCurrentBranch.mockResolvedValue(null);
    const platform = makePlatform();
    await reportUnpushedWorkInSource('conv-1', makeManagedCodebase(), platform);
    expect(platform.sendStructuredEvent).not.toHaveBeenCalled();
  });

  test('does nothing when clean and in sync', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    mockCountCommitsAhead.mockResolvedValue(0);
    mockHasUncommittedChanges.mockResolvedValue(false);
    const platform = makePlatform();
    await reportUnpushedWorkInSource('conv-1', makeManagedCodebase(), platform);
    expect(platform.sendStructuredEvent).not.toHaveBeenCalled();
  });

  test('emits system event with unpushed commit count when ahead > 0', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    mockCountCommitsAhead.mockResolvedValue(3);
    mockHasUncommittedChanges.mockResolvedValue(false);
    const platform = makePlatform();
    await reportUnpushedWorkInSource('conv-1', makeManagedCodebase(), platform);
    expect(platform.sendStructuredEvent).toHaveBeenCalledWith('conv-1', {
      type: 'system',
      content: expect.stringContaining('3 unpushed commits'),
    });
  });

  test('uses singular "commit" for exactly 1 unpushed commit', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    mockCountCommitsAhead.mockResolvedValue(1);
    mockHasUncommittedChanges.mockResolvedValue(false);
    const platform = makePlatform();
    await reportUnpushedWorkInSource('conv-1', makeManagedCodebase(), platform);
    expect(platform.sendStructuredEvent).toHaveBeenCalledWith('conv-1', {
      type: 'system',
      content: expect.stringContaining('1 unpushed commit'),
    });
  });

  test('emits system event when uncommitted changes present', async () => {
    mockGetCurrentBranch.mockResolvedValue('feature');
    mockCountCommitsAhead.mockResolvedValue(0);
    mockHasUncommittedChanges.mockResolvedValue(true);
    const platform = makePlatform();
    await reportUnpushedWorkInSource('conv-1', makeManagedCodebase(), platform);
    expect(platform.sendStructuredEvent).toHaveBeenCalledWith('conv-1', {
      type: 'system',
      content: expect.stringContaining('uncommitted changes'),
    });
  });

  test('emits system event combining both when ahead > 0 and dirty', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    mockCountCommitsAhead.mockResolvedValue(2);
    mockHasUncommittedChanges.mockResolvedValue(true);
    const platform = makePlatform();
    await reportUnpushedWorkInSource('conv-1', makeManagedCodebase(), platform);
    const call = (platform.sendStructuredEvent as ReturnType<typeof mock>).mock.calls[0];
    const content = (call[1] as { content: string }).content;
    expect(content).toContain('2 unpushed commits');
    expect(content).toContain('uncommitted changes');
  });

  test('swallows errors from git helpers and does not propagate', async () => {
    mockGetCurrentBranch.mockResolvedValue('main');
    mockCountCommitsAhead.mockRejectedValue(new Error('git subprocess failed'));
    const platform = makePlatform();
    await expect(
      reportUnpushedWorkInSource('conv-1', makeManagedCodebase(), platform)
    ).resolves.toBeUndefined();
  });
});
