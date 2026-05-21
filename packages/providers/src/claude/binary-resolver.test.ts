/**
 * Tests for the Claude binary resolver in binary mode.
 *
 * Must run in its own bun test invocation because it mocks @archon/paths
 * with BUNDLED_IS_BINARY=true, which conflicts with other test files.
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();

// Mock @archon/paths with BUNDLED_IS_BINARY = true (binary mode)
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: true,
}));

import * as resolver from './binary-resolver';

describe('resolveClaudeBinaryPath (binary mode)', () => {
  const originalEnv = process.env.CLAUDE_BIN_PATH;
  let fileExistsSpy: ReturnType<typeof spyOn>;
  let pathKindSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.CLAUDE_BIN_PATH;
    fileExistsSpy?.mockRestore();
    pathKindSpy?.mockRestore();
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_BIN_PATH = originalEnv;
    } else {
      delete process.env.CLAUDE_BIN_PATH;
    }
    fileExistsSpy?.mockRestore();
    pathKindSpy?.mockRestore();
  });

  test('uses CLAUDE_BIN_PATH env var when set and file exists', async () => {
    process.env.CLAUDE_BIN_PATH = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
  });

  test('throws when CLAUDE_BIN_PATH is set but file does not exist', async () => {
    process.env.CLAUDE_BIN_PATH = '/nonexistent/cli.js';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('missing');

    await expect(resolver.resolveClaudeBinaryPath()).rejects.toThrow(
      'CLAUDE_BIN_PATH is set to "/nonexistent/cli.js" but the file does not exist'
    );
  });

  test('uses config claudeBinaryPath when file exists', async () => {
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveClaudeBinaryPath('/custom/claude/cli.js');
    expect(result).toBe('/custom/claude/cli.js');
  });

  test('throws when config claudeBinaryPath file does not exist', async () => {
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('missing');

    await expect(resolver.resolveClaudeBinaryPath('/nonexistent/cli.js')).rejects.toThrow(
      'assistants.claude.claudeBinaryPath is set to "/nonexistent/cli.js" but the file does not exist'
    );
  });

  test('env var takes precedence over config path', async () => {
    process.env.CLAUDE_BIN_PATH = '/env/cli.js';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveClaudeBinaryPath('/config/cli.js');
    expect(result).toBe('/env/cli.js');
  });

  test('autodetects native installer path when env and config are unset', async () => {
    // Mirror the implementation: use os.homedir() + node:path.join so the
    // expected path matches the platform's actual home dir and separator.
    const expected = join(
      homedir(),
      '.local',
      'bin',
      process.platform === 'win32' ? 'claude.exe' : 'claude'
    );
    // File exists only at the native-installer path.
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation(
      (path: string) => path === expected
    );

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe(expected);
    // Log must mark this as autodetect, not 'env' or 'config' — the source
    // string is load-bearing for debug triage.
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: expected, source: 'autodetect' },
      'claude.binary_resolved'
    );
  });

  test('env var takes precedence over autodetect when both would match', async () => {
    process.env.CLAUDE_BIN_PATH = '/custom/env/claude';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe('/custom/env/claude');
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: '/custom/env/claude', source: 'env' },
      'claude.binary_resolved'
    );
  });

  test('config takes precedence over autodetect when both would match', async () => {
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveClaudeBinaryPath('/custom/config/claude');
    expect(result).toBe('/custom/config/claude');
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: '/custom/config/claude', source: 'config' },
      'claude.binary_resolved'
    );
  });

  test('throws with install instructions when nothing is configured and autodetect misses', async () => {
    // Every probe returns false — env unset, config unset, native path absent.
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    const promise = resolver.resolveClaudeBinaryPath();
    await expect(promise).rejects.toThrow('Claude Code not found');
    await expect(promise).rejects.toThrow('CLAUDE_BIN_PATH');
    // Native curl installer is Anthropic's primary recommendation.
    await expect(promise).rejects.toThrow('https://claude.ai/install.sh');
    // npm path is still documented as an alternative.
    await expect(promise).rejects.toThrow('npm install -g @anthropic-ai/claude-code');
    await expect(promise).rejects.toThrow('claudeBinaryPath');
  });

  // ─── Directory expansion (issue #1723) ──────────────────────────────────
  // The npm-distributed Claude Code package nests the native binary inside
  // a platform-specific directory (`@anthropic-ai/claude-code-<platform>`).
  // Users on Windows naturally configure that directory as
  // `claudeBinaryPath`; the resolver must transparently expand it to the
  // contained executable so the SDK's spawn doesn't ENOENT on a directory.
  // ─────────────────────────────────────────────────────────────────────────

  test('expands a configured directory to claude/claude.exe when the binary is present (config path)', async () => {
    const dir = '/opt/claude-code-package';
    const expectedFile = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((p: string) => {
      if (p === dir) return 'directory';
      if (p === expectedFile) return 'file';
      return 'missing';
    });

    const result = await resolver.resolveClaudeBinaryPath(dir);
    expect(result).toBe(expectedFile);
    // Log must show the expanded executable path, not the user's directory —
    // operators triaging spawn issues need the actual path the SDK will use.
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: expectedFile, source: 'config' },
      'claude.binary_resolved'
    );
  });

  test('expands a configured directory passed via CLAUDE_BIN_PATH', async () => {
    const dir = '/opt/claude-code-package';
    const expectedFile = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    process.env.CLAUDE_BIN_PATH = dir;
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((p: string) => {
      if (p === dir) return 'directory';
      if (p === expectedFile) return 'file';
      return 'missing';
    });

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe(expectedFile);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: expectedFile, source: 'env' },
      'claude.binary_resolved'
    );
  });

  test('throws a directory-specific error when config path is a directory missing the expected executable', async () => {
    const dir = '/some/empty/dir';
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((p: string) =>
      p === dir ? 'directory' : 'missing'
    );
    const expected = process.platform === 'win32' ? 'claude.exe' : 'claude';

    const promise = resolver.resolveClaudeBinaryPath(dir);
    await expect(promise).rejects.toThrow('assistants.claude.claudeBinaryPath');
    await expect(promise).rejects.toThrow('which is a directory');
    await expect(promise).rejects.toThrow(`does not contain ${expected}`);
  });

  test('throws a directory-specific error when CLAUDE_BIN_PATH is a directory missing the expected executable', async () => {
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

describe('pathKind', () => {
  test('returns "missing" for nonexistent paths', () => {
    expect(resolver.pathKind('/definitely/does/not/exist/anywhere/12345')).toBe('missing');
  });

  // `pathKind` is a thin wrapper around `statSync`; the file/directory
  // discrimination itself is tested via the resolver-level tests above
  // (which spy on pathKind). The integration concern that *can't* be tested
  // there — that the wrapper actually catches ENOENT instead of throwing —
  // is asserted here.
});
