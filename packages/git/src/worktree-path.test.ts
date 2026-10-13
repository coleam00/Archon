import { describe, expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';
import { isSameWorktreePath, toNativeWorktreePath } from './worktree';

describe('isSameWorktreePath', () => {
  test('on Windows, matches git forward-slash output against a native path of another case', () => {
    expect(
      isSameWorktreePath(
        'D:/a/Archon/worktrees/task-x',
        'd:\\a\\archon\\worktrees\\task-x\\',
        win32
      )
    ).toBe(true);
    expect(isSameWorktreePath('D:/a/Archon/worktrees/task-x', 'D:\\a\\Archon\\task-y', win32)).toBe(
      false
    );
  });

  test('on POSIX, case is significant and only lexical normalization applies', () => {
    expect(isSameWorktreePath('/tmp/a/../wt/', '/tmp/wt', posix)).toBe(true);
    expect(isSameWorktreePath('/tmp/WT', '/tmp/wt', posix)).toBe(false);
  });
});

describe('toNativeWorktreePath', () => {
  test('on Windows, turns git forward-slash output into the id create persists', () => {
    const created = win32.join('D:\\a\\Archon', 'worktrees', 'task-x');
    expect(toNativeWorktreePath('D:/a/Archon/worktrees/task-x', win32)).toBe(created);
  });

  test('on POSIX, returns git output byte-identical', () => {
    expect(toNativeWorktreePath('/tmp/archon/worktrees/task-x', posix)).toBe(
      '/tmp/archon/worktrees/task-x'
    );
  });
});
