/**
 * Tests for the Claude binary resolver in binary mode.
 *
 * Must run in its own bun test invocation because it mocks @archon/paths
 * with BUNDLED_IS_BINARY=true, which conflicts with other test files.
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
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

  beforeEach(() => {
    delete process.env.CLAUDE_BIN_PATH;
    fileExistsSpy?.mockRestore();
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_BIN_PATH = originalEnv;
    } else {
      delete process.env.CLAUDE_BIN_PATH;
    }
    fileExistsSpy?.mockRestore();
  });

  test('uses CLAUDE_BIN_PATH env var when set and file exists', async () => {
    process.env.CLAUDE_BIN_PATH = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
  });

  test('throws when CLAUDE_BIN_PATH is set but file does not exist', async () => {
    process.env.CLAUDE_BIN_PATH = '/nonexistent/cli.js';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveClaudeBinaryPath()).rejects.toThrow(
      'CLAUDE_BIN_PATH is set to "/nonexistent/cli.js" but the file does not exist'
    );
  });

  test('uses config claudeBinaryPath when file exists', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveClaudeBinaryPath('/custom/claude/cli.js');
    expect(result).toBe('/custom/claude/cli.js');
  });

  test('throws when config claudeBinaryPath file does not exist', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveClaudeBinaryPath('/nonexistent/cli.js')).rejects.toThrow(
      'assistants.claude.claudeBinaryPath is set to "/nonexistent/cli.js" but the file does not exist'
    );
  });

  test('env var takes precedence over config path', async () => {
    process.env.CLAUDE_BIN_PATH = '/env/cli.js';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveClaudeBinaryPath('/config/cli.js');
    expect(result).toBe('/env/cli.js');
  });

  test('autodetects native installer path when env and config are unset', async () => {
    const home = process.env.HOME ?? '/Users/test';
    const expected =
      process.platform === 'win32'
        ? `${home}\\.local\\bin\\claude.exe`
        : `${home}/.local/bin/claude`;
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
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe('/custom/env/claude');
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: '/custom/env/claude', source: 'env' },
      'claude.binary_resolved'
    );
  });

  test('config takes precedence over autodetect when both would match', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

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
});
