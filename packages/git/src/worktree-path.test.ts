import { describe, expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';
import { isSameWorktreePath } from './worktree';

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
