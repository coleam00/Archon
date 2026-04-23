/**
 * Tests for the Copilot binary resolver in binary mode.
 *
 * Must run in its own bun test invocation because it mocks @archon/paths
 * with BUNDLED_IS_BINARY=true, which conflicts with dev-mode tests.
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: true,
  getArchonHome: mock(() => '/tmp/test-archon-home'),
}));

import * as resolver from './binary-resolver';

describe('resolveCopilotBinaryPath (binary mode)', () => {
  const originalEnv = process.env.COPILOT_BIN_PATH;
  let fileExistsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.COPILOT_BIN_PATH;
    fileExistsSpy?.mockRestore();
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.COPILOT_BIN_PATH = originalEnv;
    } else {
      delete process.env.COPILOT_BIN_PATH;
    }
    fileExistsSpy?.mockRestore();
  });

  test('uses COPILOT_BIN_PATH env var when set and file exists', async () => {
    process.env.COPILOT_BIN_PATH = '/usr/local/bin/copilot';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveCopilotBinaryPath();
    expect(result).toBe('/usr/local/bin/copilot');
  });

  test('throws when COPILOT_BIN_PATH is set but file does not exist', async () => {
    process.env.COPILOT_BIN_PATH = '/nonexistent/copilot';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveCopilotBinaryPath()).rejects.toThrow('does not exist');
  });

  test('uses config cliPath when file exists', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveCopilotBinaryPath('/custom/copilot/path');
    expect(result).toBe('/custom/copilot/path');
  });

  test('throws when config cliPath file does not exist', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveCopilotBinaryPath('/nonexistent/copilot')).rejects.toThrow(
      'does not exist'
    );
  });

  test('env var takes precedence over config path', async () => {
    process.env.COPILOT_BIN_PATH = '/env/copilot';
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(true);

    const result = await resolver.resolveCopilotBinaryPath('/config/copilot');
    expect(result).toBe('/env/copilot');
  });

  test('checks vendor directory when no env or config path', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, '/');
      return normalized.includes('vendor/copilot');
    });

    const result = await resolver.resolveCopilotBinaryPath();
    expect(typeof result).toBe('string');
    const normalized = result!.replace(/\\/g, '/');
    expect(normalized).toContain('/tmp/test-archon-home/vendor/copilot/');
  });

  test('autodetects npm global install at ~/.npm-global/bin/copilot (POSIX)', async () => {
    if (process.platform === 'win32') return;
    const home = process.env.HOME ?? '/Users/test';
    const expected = `${home}/.npm-global/bin/copilot`;
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation(
      (path: string) => path === expected
    );

    const result = await resolver.resolveCopilotBinaryPath();
    expect(result).toBe(expected);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { source: 'autodetect' },
      'copilot.binary_resolved'
    );
  });

  test('autodetects homebrew install on Apple Silicon', async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation(
      (path: string) => path === '/opt/homebrew/bin/copilot'
    );

    const result = await resolver.resolveCopilotBinaryPath();
    expect(result).toBe('/opt/homebrew/bin/copilot');
    expect(mockLogger.info).toHaveBeenCalledWith(
      { source: 'autodetect' },
      'copilot.binary_resolved'
    );
  });

  test('autodetects system install at /usr/local/bin/copilot', async () => {
    if (process.platform === 'win32') return;
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation(
      (path: string) => path === '/usr/local/bin/copilot'
    );

    const result = await resolver.resolveCopilotBinaryPath();
    expect(result).toBe('/usr/local/bin/copilot');
  });

  test('vendor directory takes precedence over autodetect', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, '/');
      return normalized.includes('vendor/copilot') || normalized.includes('.npm-global');
    });

    const result = await resolver.resolveCopilotBinaryPath();
    expect(result!.replace(/\\/g, '/')).toContain('/vendor/copilot/');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'vendor' }),
      'copilot.binary_resolved'
    );
  });

  test('throws with install instructions when binary not found anywhere', async () => {
    fileExistsSpy = spyOn(resolver, 'fileExists').mockReturnValue(false);

    await expect(resolver.resolveCopilotBinaryPath()).rejects.toThrow(
      'Copilot CLI binary not found'
    );
  });
});
