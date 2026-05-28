/**
 * Tests for the Claude binary resolver in dev mode (BUNDLED_IS_BINARY=false).
 * Separate file because binary-mode tests mock BUNDLED_IS_BINARY=true.
 *
 * Dev mode normally lets the SDK resolve the binary from its bundled
 * platform package. CLAUDE_BIN_PATH is honored as an escape hatch for
 * environments where SDK auto-resolution picks the wrong variant — most
 * notably glibc Linux hosts, where the SDK prefers the musl binary first
 * and silently falls over with a misleading "not found" error.
 * Config-file path is intentionally NOT honored in dev mode (still binary-only).
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import { join } from 'node:path';
import { createMockLogger } from '../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
  BUNDLED_IS_BINARY: false,
}));

import * as resolver from './binary-resolver';
import { CLAUDE_BINARY_NAME } from './binary-resolver';

describe('resolveClaudeBinaryPath (dev mode)', () => {
  const originalEnv = process.env.CLAUDE_BIN_PATH;
  let pathKindSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    delete process.env.CLAUDE_BIN_PATH;
    pathKindSpy?.mockRestore();
    pathKindSpy = undefined;
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_BIN_PATH = originalEnv;
    } else {
      delete process.env.CLAUDE_BIN_PATH;
    }
    pathKindSpy?.mockRestore();
  });

  test('returns undefined when nothing is configured', async () => {
    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBeUndefined();
  });

  test('returns undefined when only config path is set (config is binary-mode only)', async () => {
    const result = await resolver.resolveClaudeBinaryPath('/some/custom/path');
    expect(result).toBeUndefined();
  });

  test('honors CLAUDE_BIN_PATH env var when file exists', async () => {
    process.env.CLAUDE_BIN_PATH = '/usr/local/bin/claude';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe('/usr/local/bin/claude');
  });

  test('throws when CLAUDE_BIN_PATH is set but file does not exist', async () => {
    process.env.CLAUDE_BIN_PATH = '/nonexistent/claude';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('missing');

    await expect(resolver.resolveClaudeBinaryPath()).rejects.toThrow(
      'CLAUDE_BIN_PATH is set to "/nonexistent/claude" but the file does not exist'
    );
  });

  test('env var wins over config path in dev mode', async () => {
    process.env.CLAUDE_BIN_PATH = '/env/claude';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveClaudeBinaryPath('/config/claude');
    expect(result).toBe('/env/claude');
  });

  test('falls through to undefined when CLAUDE_BIN_PATH is the empty string', async () => {
    // Pin the contract: an unset shell variable that gets exported as empty
    // (e.g. `export CLAUDE_BIN_PATH=`) must behave the same as fully unset,
    // not throw "file does not exist".
    process.env.CLAUDE_BIN_PATH = '';
    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBeUndefined();
  });

  test('expands a CLAUDE_BIN_PATH directory to its inner claude/claude.exe in dev mode', async () => {
    // validateAndExpand runs BEFORE the BUNDLED_IS_BINARY guard, so dev-mode
    // users who set CLAUDE_BIN_PATH to the npm platform-package directory
    // must also get expansion. Pin the contract so a future refactor that
    // reorders these checks fails loudly.
    const dir = '/opt/claude-code-package';
    const expectedFile = join(dir, CLAUDE_BINARY_NAME);
    process.env.CLAUDE_BIN_PATH = dir;
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((p: string) => {
      if (p === dir) return 'directory';
      if (p === expectedFile) return 'file';
      return 'missing';
    });

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe(expectedFile);
  });

  test('throws a directory-specific error when CLAUDE_BIN_PATH is a directory missing the executable in dev mode', async () => {
    const dir = '/some/empty/dir';
    process.env.CLAUDE_BIN_PATH = dir;
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((p: string) =>
      p === dir ? 'directory' : 'missing'
    );

    const promise = resolver.resolveClaudeBinaryPath();
    await expect(promise).rejects.toThrow('CLAUDE_BIN_PATH');
    await expect(promise).rejects.toThrow('which is a directory');
  });
});
