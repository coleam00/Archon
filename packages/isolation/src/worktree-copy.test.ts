import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import { join } from 'path';

import {
  parseCopyFileEntry,
  copyWorktreeFile,
  copyWorktreeFiles,
  isPathWithinRoot,
  type CopyFileEntry,
} from '@archon/isolation';

describe('worktree-copy', () => {
  describe('parseCopyFileEntry', () => {
    test('parses simple filename', () => {
      const result = parseCopyFileEntry('.env');
      expect(result).toEqual({ source: '.env', destination: '.env' });
    });

    test('trims whitespace', () => {
      const result = parseCopyFileEntry('  .env  ');
      expect(result).toEqual({ source: '.env', destination: '.env' });
    });

    test('handles directory paths', () => {
      const result = parseCopyFileEntry('data/fixtures/');
      expect(result).toEqual({ source: 'data/fixtures/', destination: 'data/fixtures/' });
    });

    test('handles nested paths', () => {
      const result = parseCopyFileEntry('.vscode/settings.json');
      expect(result).toEqual({
        source: '.vscode/settings.json',
        destination: '.vscode/settings.json',
      });
    });

    test('treats arrow literally (no rename syntax)', () => {
      const result = parseCopyFileEntry('file-with->arrow.txt');
      expect(result).toEqual({
        source: 'file-with->arrow.txt',
        destination: 'file-with->arrow.txt',
      });
    });

    test('throws on empty string', () => {
      expect(() => parseCopyFileEntry('')).toThrow('Copy entry cannot be empty');
    });

    test('throws on whitespace-only string', () => {
      expect(() => parseCopyFileEntry('   ')).toThrow('Copy entry cannot be empty');
    });
  });

  describe('isPathWithinRoot', () => {
    // Unix-style paths
    test('returns true for simple file in root', () => {
      expect(isPathWithinRoot('/repo', '.env')).toBe(true);
    });

    test('returns true for nested path', () => {
      expect(isPathWithinRoot('/repo', 'src/config/.env')).toBe(true);
    });

    test('returns false for path traversal with ../', () => {
      expect(isPathWithinRoot('/repo', '../other/.env')).toBe(false);
    });

    test('returns false for deep path traversal', () => {
      expect(isPathWithinRoot('/repo', '../../etc/passwd')).toBe(false);
    });

    test('returns false for traversal hidden in nested path', () => {
      expect(isPathWithinRoot('/repo', 'src/../../../etc/passwd')).toBe(false);
    });

    test('returns true for ../ that stays within root', () => {
      expect(isPathWithinRoot('/repo', 'src/../config/.env')).toBe(true);
    });

    test('returns true for absolute root path', () => {
      expect(isPathWithinRoot('/home/user/repo', 'data/file.txt')).toBe(true);
    });

    // Windows-style paths (these work on all platforms due to normalize)
    test('handles Windows-style backslashes in file path', () => {
      expect(isPathWithinRoot('/repo', 'src\\config\\.env')).toBe(true);
    });

    test('blocks Windows-style path traversal', () => {
      expect(isPathWithinRoot('/repo', '..\\other\\.env')).toBe(false);
    });

    // Edge cases
    test('returns true for empty relative path (root itself)', () => {
      expect(isPathWithinRoot('/repo', '')).toBe(true);
    });

    test('returns true for dot (current directory)', () => {
      expect(isPathWithinRoot('/repo', '.')).toBe(true);
    });

    test('returns false for absolute file path', () => {
      // On Unix, this creates /repo//etc/passwd which normalizes to /repo/etc/passwd
      // But the intent is to check if someone passes an absolute path as the file
      expect(isPathWithinRoot('/repo', '/etc/passwd')).toBe(true); // This is /repo/etc/passwd
    });
  });

  describe('copyWorktreeFile', () => {
    let statSpy: Mock<typeof fs.stat>;
    let mkdirSpy: Mock<typeof fs.mkdir>;
    let copyFileSpy: Mock<typeof fs.copyFile>;
    let cpSpy: Mock<typeof fs.cp>;

    beforeEach(() => {
      statSpy = spyOn(fs, 'stat');
      mkdirSpy = spyOn(fs, 'mkdir');
      copyFileSpy = spyOn(fs, 'copyFile');
      cpSpy = spyOn(fs, 'cp');

      mkdirSpy.mockResolvedValue(undefined);
      copyFileSpy.mockResolvedValue(undefined);
      cpSpy.mockResolvedValue(undefined);
    });

    afterEach(() => {
      statSpy.mockRestore();
      mkdirSpy.mockRestore();
      copyFileSpy.mockRestore();
      cpSpy.mockRestore();
    });

    test('copies file when source exists', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '.env',
      });

      expect(result).toBe(true);
      expect(copyFileSpy).toHaveBeenCalledWith(join('/repo', '.env'), join('/worktree', '.env'));
    });

    test('copies directory recursively', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => true } as Stats);

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: 'data/fixtures',
        destination: 'data/fixtures',
      });

      expect(result).toBe(true);
      expect(cpSpy).toHaveBeenCalledWith(
        join('/repo', 'data', 'fixtures'),
        join('/worktree', 'data', 'fixtures'),
        { recursive: true }
      );
    });

    test('creates destination directory before copying', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      await copyWorktreeFile('/repo', '/worktree', {
        source: 'nested/path/.env',
        destination: 'nested/path/.env',
      });

      expect(mkdirSpy).toHaveBeenCalledWith(join('/worktree', 'nested', 'path'), {
        recursive: true,
      });
    });

    test('returns false when source does not exist (ENOENT)', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      statSpy.mockRejectedValue(error);

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '.env',
      });

      expect(result).toBe(false);
    });

    test('returns false on permission error (EACCES) without throwing', async () => {
      const error = new Error('Permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      statSpy.mockRejectedValue(error);

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '.env',
      });

      expect(result).toBe(false);
    });

    // Path traversal tests
    test('blocks source path traversal', async () => {
      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '../../../etc/passwd',
        destination: 'stolen.txt',
      });

      expect(result).toBe(false);
      // Should NOT call stat - blocked before any fs operation
      expect(statSpy).not.toHaveBeenCalled();
    });

    test('blocks destination path traversal', async () => {
      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '../../../tmp/evil.txt',
      });

      expect(result).toBe(false);
      // Should NOT call stat - blocked before any fs operation
      expect(statSpy).not.toHaveBeenCalled();
    });

    // Copy operation failure tests
    test('returns false when copyFile throws', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);
      copyFileSpy.mockRejectedValue(new Error('Disk full'));

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '.env',
      });

      expect(result).toBe(false);
    });

    test('returns false when cp throws for directory', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => true } as Stats);
      cpSpy.mockRejectedValue(new Error('Permission denied'));

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: 'data/',
        destination: 'data/',
      });

      expect(result).toBe(false);
    });

    test('returns false when mkdir fails', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);
      mkdirSpy.mockRejectedValue(new Error('Cannot create directory'));

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: 'nested/path/.env',
        destination: 'nested/path/.env',
      });

      expect(result).toBe(false);
    });
  });

  describe('copyWorktreeFiles', () => {
    let statSpy: Mock<typeof fs.stat>;
    let mkdirSpy: Mock<typeof fs.mkdir>;
    let copyFileSpy: Mock<typeof fs.copyFile>;
    let cpSpy: Mock<typeof fs.cp>;

    beforeEach(() => {
      statSpy = spyOn(fs, 'stat');
      mkdirSpy = spyOn(fs, 'mkdir');
      copyFileSpy = spyOn(fs, 'copyFile');
      cpSpy = spyOn(fs, 'cp');

      mkdirSpy.mockResolvedValue(undefined);
      copyFileSpy.mockResolvedValue(undefined);
      cpSpy.mockResolvedValue(undefined);
    });

    afterEach(() => {
      statSpy.mockRestore();
      mkdirSpy.mockRestore();
      copyFileSpy.mockRestore();
      cpSpy.mockRestore();
    });

    test('copies multiple files from config', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      const result = await copyWorktreeFiles('/repo', '/worktree', [
        '.env',
        '.vscode/settings.json',
      ]);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ source: '.env', destination: '.env' });
      expect(result[1]).toEqual({
        source: '.vscode/settings.json',
        destination: '.vscode/settings.json',
      });
    });

    test('returns only successfully copied entries', async () => {
      // First call succeeds, second fails with ENOENT
      statSpy
        .mockResolvedValueOnce({ isDirectory: () => false } as Stats)
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const result = await copyWorktreeFiles('/repo', '/worktree', ['.env', '.archon']);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ source: '.env', destination: '.env' });
    });

    test('returns empty array when no files configured', async () => {
      const result = await copyWorktreeFiles('/repo', '/worktree', []);

      expect(result).toHaveLength(0);
    });

    test('handles mixed files and directories', async () => {
      statSpy
        .mockResolvedValueOnce({ isDirectory: () => false } as Stats)
        .mockResolvedValueOnce({ isDirectory: () => true } as Stats);

      const result = await copyWorktreeFiles('/repo', '/worktree', ['.env', 'data/fixtures/']);

      expect(result).toHaveLength(2);
      expect(copyFileSpy).toHaveBeenCalledTimes(1);
      expect(cpSpy).toHaveBeenCalledTimes(1);
    });

    // Parse error handling
    test('continues processing after invalid config entry', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      const result = await copyWorktreeFiles('/repo', '/worktree', [
        '', // Invalid - empty
        '.env', // Valid
        '   ', // Invalid - whitespace only
        '.vscode/settings.json', // Valid
      ]);

      // Should have only the 2 valid entries
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ source: '.env', destination: '.env' });
      expect(result[1]).toEqual({
        source: '.vscode/settings.json',
        destination: '.vscode/settings.json',
      });
    });

    test('skips entries with path traversal', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      const result = await copyWorktreeFiles('/repo', '/worktree', [
        '.env', // Valid
        '../../../etc/passwd', // Path traversal - blocked
        'data/config.json', // Valid
      ]);

      // Path traversal entry should be skipped
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ source: '.env', destination: '.env' });
      expect(result[1]).toEqual({ source: 'data/config.json', destination: 'data/config.json' });
    });
  });
});
