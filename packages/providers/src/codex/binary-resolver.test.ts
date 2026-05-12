/**
 * Tests for the Codex binary resolver in binary mode.
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
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

import * as resolver from './binary-resolver';

describe('resolveCodexBinaryPath (binary mode)', () => {
  const originalEnv = process.env.CODEX_BIN_PATH;
  let fileExistsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.CODEX_BIN_PATH;
    fileExistsSpy?.mockRestore();
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.CODEX_BIN_PATH = originalEnv;
    } else {
      delete process.env.CODEX_BIN_PATH;
    }
    fileExistsSpy?.mockRestore();
  });

  test('uses CODEX_BIN_PATH env var when set and file exists', async () => {
    process.env.CODEX_BIN_PATH = '/usr/local/bin/codex';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveCodexBinaryPath();
    expect(result).toBe('/usr/local/bin/codex');
  });

  test('throws when CODEX_BIN_PATH is set but file does not exist', async () => {
    process.env.CODEX_BIN_PATH = '/nonexistent/codex';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveCodexBinaryPath()).rejects.toThrow('does not exist');
  });

  test('uses config codexBinaryPath when file exists', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveCodexBinaryPath('/custom/codex/path');
    expect(result).toBe('/custom/codex/path');
  });

  test('throws when config codexBinaryPath file does not exist', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveCodexBinaryPath('/nonexistent/codex')).rejects.toThrow(
      'does not exist'
    );
  });

  test('env var takes precedence over config path', async () => {
    process.env.CODEX_BIN_PATH = '/env/codex';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveCodexBinaryPath('/config/codex');
    expect(result).toBe('/env/codex');
  });

  test('checks vendor directory when no env or config path', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, '/');
      return normalized.includes('vendor/codex');
    });

    const result = await resolver.resolveCodexBinaryPath();
    expect(typeof result).toBe('string');
    const normalized = result!.replace(/\\/g, '/');
    expect(normalized).toContain('/tmp/test-archon-home/vendor/codex/');
  });

  test('autodetects npm global install at ~/.npm-global/bin/codex (POSIX)', async () => {
    if (process.platform === 'win32') return; // POSIX-only probe
    const home = process.env.HOME ?? '/Users/test';
    const expected = `${home}/.npm-global/bin/codex`;
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation(
      (path: string) => path === expected
    );

    const result = await resolver.resolveCodexBinaryPath();
    expect(result).toBe(expected);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: expected, source: 'autodetect' },
      'codex.binary_resolved'
    );
  });

  test('autodetects homebrew install on Apple Silicon', async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      // `/opt/homebrew/bin/codex` is only probed on darwin-arm64; on other
      // hosts this test has nothing to assert (the probe list excludes it).
      return;
    }
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation(
      (path: string) => path === '/opt/homebrew/bin/codex'
    );

    const result = await resolver.resolveCodexBinaryPath();
    expect(result).toBe('/opt/homebrew/bin/codex');
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: '/opt/homebrew/bin/codex', source: 'autodetect' },
      'codex.binary_resolved'
    );
  });

  test('autodetects system install at /usr/local/bin/codex', async () => {
    if (process.platform === 'win32') {
      // /usr/local/bin is not probed on Windows.
      return;
    }
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation(
      (path: string) => path === '/usr/local/bin/codex'
    );

    const result = await resolver.resolveCodexBinaryPath();
    expect(result).toBe('/usr/local/bin/codex');
  });

  test('vendor directory takes precedence over autodetect', async () => {
    // Both vendor and npm-global would match; vendor must win (lower tier #).
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, '/');
      return normalized.includes('vendor/codex') || normalized.includes('.npm-global');
    });

    const result = await resolver.resolveCodexBinaryPath();
    expect(result!.replace(/\\/g, '/')).toContain('/vendor/codex/');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'vendor' }),
      'codex.binary_resolved'
    );
  });

  test('throws with install instructions when binary not found anywhere', async () => {
    // Env unset, config unset, vendor dir empty, every autodetect path missing.
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveCodexBinaryPath()).rejects.toThrow('Codex CLI binary not found');
  });
});
