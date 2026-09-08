/**
 * Tests for the Claude binary resolver in dev mode (BUNDLED_IS_BINARY=false).
 * Separate file because binary-mode tests mock BUNDLED_IS_BINARY=true.
 *
 * Explicit env/config pins override the SDK's bundled platform package.
 */
import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'node:path';
import { createMockLogger } from '../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
  BUNDLED_IS_BINARY: false,
}));

import * as resolver from './binary-resolver';
import { CLAUDE_BINARY_NAME } from './binary-resolver';

describe('resolveClaudeBinaryPath (dev mode)', () => {
  let originalEnv: string | undefined;
  let pathKindSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    originalEnv = process.env.CLAUDE_BIN_PATH;
    delete process.env.CLAUDE_BIN_PATH;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_BIN_PATH = originalEnv;
    } else {
      delete process.env.CLAUDE_BIN_PATH;
    }
    pathKindSpy?.mockRestore();
    pathKindSpy = undefined;
  });

  test('returns undefined when nothing is configured', async () => {
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');
    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBeUndefined();
    expect(pathKindSpy).not.toHaveBeenCalled();
  });

  test('honors a configured executable and reports its source', async () => {
    expect(await resolver.resolveClaudeBinaryWithSource(process.execPath)).toEqual({
      path: process.execPath,
      source: 'config',
    });
    expect(await resolver.resolveClaudeBinaryPath(process.execPath)).toBe(process.execPath);
  });

  test('honors CLAUDE_BIN_PATH env var when file exists', async () => {
    process.env.CLAUDE_BIN_PATH = process.execPath;
    expect(await resolver.resolveClaudeBinaryWithSource()).toEqual({
      path: process.execPath,
      source: 'env',
    });
  });

  test('throws when CLAUDE_BIN_PATH is set but file does not exist', async () => {
    process.env.CLAUDE_BIN_PATH = '/nonexistent/claude';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('missing');

    await expect(resolver.resolveClaudeBinaryPath()).rejects.toThrow(
      'CLAUDE_BIN_PATH is set to "/nonexistent/claude" but the file does not exist'
    );
  });

  test('env var wins over config path in dev mode', async () => {
    process.env.CLAUDE_BIN_PATH = process.execPath;

    const result = await resolver.resolveClaudeBinaryWithSource('/missing/config/claude');
    expect(result).toEqual({ path: process.execPath, source: 'env' });
  });

  test('an invalid env pin refuses a valid config executable', async () => {
    process.env.CLAUDE_BIN_PATH = join(process.execPath, 'missing-claude');
    await expect(resolver.resolveClaudeBinaryPath(process.execPath)).rejects.toThrow(
      'CLAUDE_BIN_PATH'
    );
  });

  test('an invalid config pin fails instead of using the SDK binary', async () => {
    await expect(
      resolver.resolveClaudeBinaryPath(join(process.execPath, 'missing-claude'))
    ).rejects.toThrow('assistants.claude.claudeBinaryPath');
  });

  test.each(['env', 'config'] as const)(
    'an invalid %s pin gives repair advice without probing compiled-mode candidates',
    async source => {
      const missing = '/missing/claude';
      if (source === 'env') process.env.CLAUDE_BIN_PATH = missing;
      pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
        path === missing ? 'missing' : 'file'
      );
      const label = source === 'env' ? 'CLAUDE_BIN_PATH' : 'assistants.claude.claudeBinaryPath';
      await expect(
        resolver.resolveClaudeBinaryPath(source === 'config' ? missing : undefined)
      ).rejects.toThrow(
        new Error(
          `${label} is set to "${missing}" but the file does not exist.\n` +
            'Please verify the path points to the Claude Code executable (native binary\n' +
            'from the curl/PowerShell installer, or cli.js from an npm global install).'
        )
      );
      expect(pathKindSpy).toHaveBeenCalledTimes(1);
      expect(pathKindSpy).toHaveBeenCalledWith(missing);
    }
  );

  test('an empty env pin allows a valid config pin', async () => {
    process.env.CLAUDE_BIN_PATH = '';
    expect(await resolver.resolveClaudeBinaryPath(process.execPath)).toBe(process.execPath);
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

  test('expands a configured directory and reports the config source', async () => {
    const dir = '/opt/claude-code-package';
    const expectedFile = join(dir, CLAUDE_BINARY_NAME);
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) => {
      if (path === dir) return 'directory';
      if (path === expectedFile) return 'file';
      return 'missing';
    });
    expect(await resolver.resolveClaudeBinaryWithSource(dir)).toEqual({
      path: expectedFile,
      source: 'config',
    });
  });

  test('rejects a config directory without its executable', async () => {
    const dir = '/empty/claude-package';
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
      path === dir ? 'directory' : 'missing'
    );
    await expect(resolver.resolveClaudeBinaryPath(dir)).rejects.toThrow(
      `assistants.claude.claudeBinaryPath is set to "${dir}", which is a directory, but it does not contain ${CLAUDE_BINARY_NAME}.`
    );
  });
});
