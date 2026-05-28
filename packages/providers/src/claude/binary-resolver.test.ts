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
import { CLAUDE_BINARY_NAME } from './binary-resolver';

describe('resolveClaudeBinaryPath (binary mode)', () => {
  const originalEnv = process.env.CLAUDE_BIN_PATH;
  let pathKindSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    delete process.env.CLAUDE_BIN_PATH;
    pathKindSpy?.mockRestore();
    pathKindSpy = undefined;
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_BIN_PATH = originalEnv;
    } else {
      delete process.env.CLAUDE_BIN_PATH;
    }
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
    const expected = join(homedir(), '.local', 'bin', CLAUDE_BINARY_NAME);
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
      path === expected ? 'file' : 'missing'
    );

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe(expected);
    // The source label is load-bearing for debug triage.
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: expected, source: 'autodetect' },
      'claude.binary_resolved'
    );
  });

  test('autodetect rejects a directory at the native installer path', async () => {
    // A directory at ~/.local/bin/claude indicates a broken install; the
    // resolver must NOT silently hand it to the SDK (which would ENOENT).
    // Expansion is deliberately limited to user-configured paths.
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('directory');

    const promise = resolver.resolveClaudeBinaryPath();
    await expect(promise).rejects.toThrow('Claude Code not found');
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
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('missing');

    const promise = resolver.resolveClaudeBinaryPath();
    await expect(promise).rejects.toThrow('Claude Code not found');
    await expect(promise).rejects.toThrow('CLAUDE_BIN_PATH');
    // Native curl installer is Anthropic's primary recommendation.
    await expect(promise).rejects.toThrow('https://claude.ai/install.sh');
    // npm path is still documented as an alternative.
    await expect(promise).rejects.toThrow('npm install -g @anthropic-ai/claude-code');
    await expect(promise).rejects.toThrow('claudeBinaryPath');
  });

  // Directory expansion: the npm-distributed Claude Code package nests the
  // native binary inside a platform-specific directory
  // (`@anthropic-ai/claude-code-<platform>`). Users on Windows naturally
  // configure that directory as `claudeBinaryPath`; the resolver must
  // transparently expand it to the contained executable so the SDK's spawn
  // doesn't ENOENT on a directory.

  test('expands a configured directory to claude/claude.exe when the binary is present (config path)', async () => {
    const dir = '/opt/claude-code-package';
    const expectedFile = join(dir, CLAUDE_BINARY_NAME);
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((p: string) => {
      if (p === dir) return 'directory';
      if (p === expectedFile) return 'file';
      return 'missing';
    });

    const result = await resolver.resolveClaudeBinaryPath(dir);
    expect(result).toBe(expectedFile);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: expectedFile, source: 'config' },
      'claude.binary_resolved'
    );
  });

  test('expands a configured directory passed via CLAUDE_BIN_PATH', async () => {
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

    const promise = resolver.resolveClaudeBinaryPath(dir);
    await expect(promise).rejects.toThrow('assistants.claude.claudeBinaryPath');
    await expect(promise).rejects.toThrow('which is a directory');
    await expect(promise).rejects.toThrow(`does not contain ${CLAUDE_BINARY_NAME}`);
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
  test('returns "file" for a real file', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'archon-pathkind-'));
    const file = join(dir, 'a-file');
    try {
      writeFileSync(file, 'hello');
      expect(resolver.pathKind(file)).toBe('file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns "directory" for a real directory', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'archon-pathkind-'));
    try {
      expect(resolver.pathKind(dir)).toBe('directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns "missing" for nonexistent paths', () => {
    expect(resolver.pathKind('/definitely/does/not/exist/anywhere/12345')).toBe('missing');
  });

  test('returns "missing" for a broken symlink without throwing', async () => {
    // statSync follows symlinks by default — broken targets raise ENOENT,
    // which must be caught and reported as 'missing' so the resolver's
    // "file does not exist" path fires instead of an uncaught exception.
    const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'archon-pathkind-'));
    const link = join(dir, 'broken-link');
    try {
      symlinkSync(join(dir, 'nonexistent-target'), link);
      expect(resolver.pathKind(link)).toBe('missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
