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
import { createMockLogger } from '../test/mocks/logger';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => createMockLogger()),
  BUNDLED_IS_BINARY: false,
}));

import * as resolver from './binary-resolver';

describe('resolveClaudeBinaryPath (dev mode)', () => {
  const originalEnv = process.env.CLAUDE_BIN_PATH;
  let fileExistsSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    delete process.env.CLAUDE_BIN_PATH;
    fileExistsSpy?.mockRestore();
    fileExistsSpy = undefined;
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_BIN_PATH = originalEnv;
    } else {
      delete process.env.CLAUDE_BIN_PATH;
    }
    fileExistsSpy?.mockRestore();
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
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveClaudeBinaryPath();
    expect(result).toBe('/usr/local/bin/claude');
  });

  test('throws when CLAUDE_BIN_PATH is set but file does not exist', async () => {
    process.env.CLAUDE_BIN_PATH = '/nonexistent/claude';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveClaudeBinaryPath()).rejects.toThrow(
      'CLAUDE_BIN_PATH is set to "/nonexistent/claude" but the file does not exist'
    );
  });

  test('env var wins over config path in dev mode', async () => {
    process.env.CLAUDE_BIN_PATH = '/env/claude';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveClaudeBinaryPath('/config/claude');
    expect(result).toBe('/env/claude');
  });
});
