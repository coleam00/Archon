import { describe, expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';
import { isSameDefaultCwd } from './codebase-path';

describe('isSameDefaultCwd', () => {
  test('win32 treats slash direction and drive-letter case as one directory', () => {
    expect(isSameDefaultCwd('E:/Projects/Quay2', 'E:\\Projects\\Quay2', win32)).toBe(true);
    expect(isSameDefaultCwd('e:\\Projects\\Quay2', 'E:/Projects/Quay2', win32)).toBe(true);
  });

  test('win32 keeps different directories and non-drive case apart', () => {
    expect(isSameDefaultCwd('E:/Projects/Quay2', 'E:\\Projects\\Quay3', win32)).toBe(false);
    expect(isSameDefaultCwd('E:/Projects/Quay2', 'E:\\projects\\Quay2', win32)).toBe(false);
  });

  test('posix compares the exact string', () => {
    expect(isSameDefaultCwd('/a/b', '/a/b', posix)).toBe(true);
    expect(isSameDefaultCwd('/a/B', '/a/b', posix)).toBe(false);
    expect(isSameDefaultCwd('/a\\b', '/a/b', posix)).toBe(false);
  });
});
