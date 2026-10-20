import { mock } from 'bun:test';
import * as paths from '@archon/paths';
import type { WorktreePath } from '../types';

const realPaths = { ...paths };
export const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};
// Capture native exports before replacing the registry; load Git only after the logger mock.
mock.module('@archon/paths', () => ({ ...realPaths, createLogger: () => mockLogger }));
export const git = await import('../index');
export const repo = git.toRepoPath;
export const branch = git.toBranchName;
export const worktree = git.toWorktreePath;
export const listed = (path: string): WorktreePath => worktree(git.toNativeWorktreePath(path));

export const output = (stdout = '') => ({ stdout, stderr: '' });
export function clearLogger(): void {
  for (const method of Object.values(mockLogger)) method.mockClear();
}
