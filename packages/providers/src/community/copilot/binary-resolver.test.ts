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
  let isExecutableFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.COPILOT_BIN_PATH;
    fileExistsSpy?.mockRestore();
    isExecutableFileSpy?.mockRestore();
    mockLogger.info.mockClear();
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.COPILOT_BIN_PATH = originalEnv;
    } else {
      delete process.env.COPILOT_BIN_PATH;
    }
    fileExistsSpy?.mockRestore();
    isExecutableFileSpy?.mockRestore();
  });

  test('uses COPILOT_BIN_PATH env var when set and file is executable', async () => {
    process.env.COPILOT_BIN_PATH = '/usr/local/bin/copilot';
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(true);

    const result = await resolver.resolveCopilotBinaryPath();
    expect(result).toBe('/usr/local/bin/copilot');
  });

  test('throws when COPILOT_BIN_PATH is set but path is not executable', async () => {
    process.env.COPILOT_BIN_PATH = '/nonexistent/copilot';
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(false);

    await expect(resolver.resolveCopilotBinaryPath()).rejects.toThrow('is not an executable file');
  });

  test('uses config cliPath when file is executable', async () => {
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(true);

    const result = await resolver.resolveCopilotBinaryPath('/custom/copilot/path');
    expect(result).toBe('/custom/copilot/path');
  });

  test('throws when config cliPath is not executable', async () => {
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(false);

    await expect(resolver.resolveCopilotBinaryPath('/nonexistent/copilot')).rejects.toThrow(
      'is not an executable file'
    );
  });

  test('env var takes precedence over config path', async () => {
    process.env.COPILOT_BIN_PATH = '/env/copilot';
    isExecutableFileSpy = spyOn(resolver, 'isExecutableFile').mockReturnValue(true);

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

describe('isExecutableFile', () => {
  // These tests run real fs ops against fixtures in os.tmpdir(). They exercise
  // the actual statSync / accessSync code path rather than mocking fs.
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-copilot-resolver-'));
  const execFile = path.join(tmpRoot, 'has-exec-bit');
  const noExecFile = path.join(tmpRoot, 'no-exec-bit');
  const dirPath = path.join(tmpRoot, 'a-directory');
  const missingPath = path.join(tmpRoot, 'does-not-exist');

  fs.writeFileSync(execFile, '#!/bin/sh\necho hi\n');
  fs.chmodSync(execFile, 0o755);
  fs.writeFileSync(noExecFile, 'plain text\n');
  fs.chmodSync(noExecFile, 0o644);
  fs.mkdirSync(dirPath);

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('returns true for a regular file with the exec bit set', () => {
    expect(resolver.isExecutableFile(execFile)).toBe(true);
  });

  test('returns false for a regular file without the exec bit (POSIX only)', () => {
    if (process.platform === 'win32') return; // win32 has no Unix exec bits
    expect(resolver.isExecutableFile(noExecFile)).toBe(false);
  });

  test('returns false for a directory', () => {
    expect(resolver.isExecutableFile(dirPath)).toBe(false);
  });

  test('returns false for a missing path', () => {
    expect(resolver.isExecutableFile(missingPath)).toBe(false);
  });
});
