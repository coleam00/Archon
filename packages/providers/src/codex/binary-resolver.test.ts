/**
 * Tests for the Codex binary resolver in binary mode.
 *
 * Must run in its own bun test invocation because it mocks @archon/paths
 * with BUNDLED_IS_BINARY=true, which conflicts with other test files.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

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

const CODEX_BINARY_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex';
const VENDOR_BINARY_PATH = join('/tmp/test-archon-home', 'vendor', 'codex', CODEX_BINARY_NAME);
const FIRST_AUTODETECT_PATH =
  process.platform === 'win32'
    ? process.env.APPDATA
      ? join(process.env.APPDATA, 'npm', 'codex.cmd')
      : join(homedir(), '.npm-global', 'codex.cmd')
    : join(homedir(), '.npm-global', 'bin', 'codex');

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected promise to reject');
}

describe('resolveCodexBinaryPath (binary mode)', () => {
  const originalEnv = process.env.CODEX_BIN_PATH;
  let pathKindSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    delete process.env.CODEX_BIN_PATH;
    pathKindSpy?.mockRestore();
    pathKindSpy = undefined;
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.CODEX_BIN_PATH = originalEnv;
    } else {
      delete process.env.CODEX_BIN_PATH;
    }
    pathKindSpy?.mockRestore();
  });

  test('uses CODEX_BIN_PATH env var when set and file exists', async () => {
    process.env.CODEX_BIN_PATH = '/usr/local/bin/codex';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveCodexBinaryPath();
    expect(result).toBe('/usr/local/bin/codex');
  });

  test('throws when CODEX_BIN_PATH is set but file does not exist', async () => {
    process.env.CODEX_BIN_PATH = '/nonexistent/codex';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('missing');

    expect(await rejectionMessage(resolver.resolveCodexBinaryPath())).toBe(
      'CODEX_BIN_PATH is set to "/nonexistent/codex" but the file does not exist.\n' +
        'Please verify the path points to the Codex CLI binary.'
    );
  });

  test.each([
    [
      'CODEX_BIN_PATH',
      'CODEX_BIN_PATH',
      'Please verify the path points to the Codex CLI binary.',
      true,
    ],
    [
      'assistants.codex.codexBinaryPath',
      'codexBinaryPath',
      'Please verify the path in .archon/config.yaml points to the Codex CLI binary.',
      false,
    ],
  ] as const)(
    'names the vendor binary before autodetect when %s is stale without using it',
    async (sourceLabel, removableSetting, instruction, usesEnv) => {
      const stalePath = '/stale/codex';
      if (usesEnv) process.env.CODEX_BIN_PATH = stalePath;
      pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
        path === VENDOR_BINARY_PATH || path === FIRST_AUTODETECT_PATH ? 'file' : 'missing'
      );

      const configuredPath = usesEnv ? undefined : stalePath;
      expect(await rejectionMessage(resolver.resolveCodexBinaryPath(configuredPath))).toBe(
        `${sourceLabel} is set to "${stalePath}" but the file does not exist.\n` +
          `${instruction}\n\n` +
          `A Codex binary was found at ${VENDOR_BINARY_PATH}.\n` +
          `Update ${sourceLabel} to that path, or remove ${removableSetting} to let Archon detect it.`
      );
      expect(pathKindSpy).toHaveBeenCalledWith(VENDOR_BINARY_PATH);
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ binaryPath: VENDOR_BINARY_PATH }),
        'codex.binary_resolved'
      );
    }
  );

  test('uses config codexBinaryPath when file exists', async () => {
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveCodexBinaryPath('/custom/codex/path');
    expect(result).toBe('/custom/codex/path');
  });

  test('throws when config codexBinaryPath file does not exist', async () => {
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('missing');

    expect(await rejectionMessage(resolver.resolveCodexBinaryPath('/nonexistent/codex'))).toBe(
      'assistants.codex.codexBinaryPath is set to "/nonexistent/codex" but the file does not exist.\n' +
        'Please verify the path in .archon/config.yaml points to the Codex CLI binary.'
    );
  });

  test('skips directory candidates when diagnosing a stale pin', async () => {
    const stalePath = '/stale/config/codex';
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) => {
      if (path === VENDOR_BINARY_PATH) return 'directory';
      if (path === FIRST_AUTODETECT_PATH) return 'file';
      return 'missing';
    });

    expect(await rejectionMessage(resolver.resolveCodexBinaryPath(stalePath))).toContain(
      `A Codex binary was found at ${FIRST_AUTODETECT_PATH}.`
    );
  });

  test('expands a CODEX_BIN_PATH directory to its contained executable', async () => {
    const directory = '/opt/codex-package';
    const expected = join(directory, CODEX_BINARY_NAME);
    process.env.CODEX_BIN_PATH = directory;
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) => {
      if (path === directory) return 'directory';
      if (path === expected) return 'file';
      return 'missing';
    });

    const result = await resolver.resolveCodexBinaryPath();
    expect(result).toBe(expected);
  });

  test('expands a config codexBinaryPath directory to its contained executable', async () => {
    const directory = '/opt/codex-package';
    const expected = join(directory, CODEX_BINARY_NAME);
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) => {
      if (path === directory) return 'directory';
      if (path === expected) return 'file';
      return 'missing';
    });

    const result = await resolver.resolveCodexBinaryPath(directory);
    expect(result).toBe(expected);
  });

  test('rejects a CODEX_BIN_PATH directory without the executable', async () => {
    const directory = '/opt/empty-codex-package';
    process.env.CODEX_BIN_PATH = directory;
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
      path === directory ? 'directory' : 'missing'
    );

    expect(await rejectionMessage(resolver.resolveCodexBinaryPath())).toBe(
      `CODEX_BIN_PATH is set to "${directory}", which is a directory, but it does not contain ${CODEX_BINARY_NAME}.\n` +
        'Please point this setting at the Codex CLI binary itself.'
    );
  });

  test('rejects a config codexBinaryPath directory without the executable', async () => {
    const directory = '/opt/empty-codex-package';
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
      path === directory ? 'directory' : 'missing'
    );

    expect(await rejectionMessage(resolver.resolveCodexBinaryPath(directory))).toBe(
      `assistants.codex.codexBinaryPath is set to "${directory}", which is a directory, but it does not contain ${CODEX_BINARY_NAME}.\n` +
        'Please point this setting at the Codex CLI binary itself.'
    );
  });

  test('env var takes precedence over config path', async () => {
    process.env.CODEX_BIN_PATH = '/env/codex';
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveCodexBinaryPath('/config/codex');
    expect(result).toBe('/env/codex');
  });

  test('checks vendor directory when no env or config path', async () => {
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, '/');
      return normalized.includes('vendor/codex') ? 'file' : 'missing';
    });

    const result = await resolver.resolveCodexBinaryPath();
    expect(typeof result).toBe('string');
    const normalized = result!.replace(/\\/g, '/');
    expect(normalized).toContain('/tmp/test-archon-home/vendor/codex/');
  });

  test('autodetects npm global install at ~/.npm-global/bin/codex (POSIX)', async () => {
    if (process.platform === 'win32') return; // POSIX-only probe
    const expected = `${homedir()}/.npm-global/bin/codex`;
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
      path === expected ? 'file' : 'missing'
    );

    const result = await resolver.resolveCodexBinaryPath();
    expect(result).toBe(expected);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: expected, source: 'autodetect' },
      'codex.binary_resolved'
    );
  });

  test('autodetects npm global install at %APPDATA%\\npm\\codex.cmd (Windows)', async () => {
    if (process.platform !== 'win32') return; // Windows-only probe
    const appData = process.env.APPDATA ?? 'C:\\Users\\test\\AppData\\Roaming';
    const expected = `${appData}\\npm\\codex.cmd`;
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
      path === expected ? 'file' : 'missing'
    );

    const result = await resolver.resolveCodexBinaryPath();
    expect(result).toBe(expected);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { binaryPath: expected, source: 'autodetect' },
      'codex.binary_resolved'
    );
  });

  test('config codexBinaryPath takes precedence over autodetect', async () => {
    // Both the explicit config path AND a typical autodetect path are
    // present on disk; config must win. Mirrors the env-over-config and
    // env-over-autodetect tests above so the four-tier precedence
    // (env → config → vendor → autodetect) is fully covered.
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('file');

    const result = await resolver.resolveCodexBinaryPath('/explicit/config/codex');
    expect(result).toBe('/explicit/config/codex');
  });

  test('autodetects homebrew install on Apple Silicon', async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      // `/opt/homebrew/bin/codex` is only probed on darwin-arm64; on other
      // hosts this test has nothing to assert (the probe list excludes it).
      return;
    }
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
      path === '/opt/homebrew/bin/codex' ? 'file' : 'missing'
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
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) =>
      path === '/usr/local/bin/codex' ? 'file' : 'missing'
    );

    const result = await resolver.resolveCodexBinaryPath();
    expect(result).toBe('/usr/local/bin/codex');
  });

  test('vendor directory takes precedence over autodetect', async () => {
    // Both vendor and npm-global would match; vendor must win (lower tier #).
    pathKindSpy = spyOn(resolver, 'pathKind').mockImplementation((path: string) => {
      const normalized = path.replace(/\\/g, '/');
      return normalized.includes('vendor/codex') || normalized.includes('.npm-global')
        ? 'file'
        : 'missing';
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
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('missing');

    await expect(resolver.resolveCodexBinaryPath()).rejects.toThrow('Codex CLI binary not found');
  });

  test('does not resolve lower-tier directories as binaries', async () => {
    pathKindSpy = spyOn(resolver, 'pathKind').mockReturnValue('directory');

    await expect(resolver.resolveCodexBinaryPath()).rejects.toThrow('Codex CLI binary not found');
  });
});
