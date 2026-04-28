/**
 * Tests for the Codex binary resolver in binary mode.
 *
 * Must run in its own bun test invocation because it mocks @archon/paths
 * with BUNDLED_IS_BINARY=true, which conflicts with other test files.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
let mockArchonHome = '/tmp/test-archon-home';

// Mock @archon/paths with BUNDLED_IS_BINARY = true (binary mode)
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  BUNDLED_IS_BINARY: true,
  getArchonHome: mock(() => mockArchonHome),
}));

import * as resolver from './binary-resolver';

describe('resolveCodexBinaryPath (binary mode)', () => {
  const originalEnv = process.env.CODEX_BIN_PATH;
  let fileExistsSpy: ReturnType<typeof spyOn>;
  let hashSpy: ReturnType<typeof spyOn>;
  let tempArchonHome: string;

  beforeEach(() => {
    delete process.env.CODEX_BIN_PATH;
    fileExistsSpy?.mockRestore();
    hashSpy?.mockRestore();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
    tempArchonHome = mkdtempSync(join(tmpdir(), 'archon-codex-home-'));
    mockArchonHome = tempArchonHome;
    // Mock verifyOrPinBinaryHash to avoid filesystem access during resolution tests
    hashSpy = spyOn(resolver, 'verifyOrPinBinaryHash').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tempArchonHome, { recursive: true, force: true });
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.CODEX_BIN_PATH = originalEnv;
    } else {
      delete process.env.CODEX_BIN_PATH;
    }
    fileExistsSpy?.mockRestore();
    hashSpy?.mockRestore();
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
    expect(normalized).toContain(`${mockArchonHome.replace(/\\/g, '/')}/vendor/codex/`);
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

describe('verifyOrPinBinaryHash', () => {
  let tempArchonHome: string;

  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    tempArchonHome = mkdtempSync(join(tmpdir(), 'archon-codex-pin-'));
    mockArchonHome = tempArchonHome;
    // Clear the in-process verified-paths cache so each test exercises a real
    // hash + pin file roundtrip rather than the memoized fast path.
    resolver.resetVerifiedHashCacheForTests();
  });

  afterEach(() => {
    rmSync(tempArchonHome, { recursive: true, force: true });
  });

  function getTrustPinPath(binaryPath: string): string {
    // Mirrors the resolver's logical-path keying — never realpath.
    const logicalPath = resolvePath(binaryPath);
    const pinName = createHash('sha256').update(logicalPath).digest('hex') + '.sha256';
    return join(mockArchonHome, 'trust/codex', pinName);
  }

  test('throws on hash mismatch', () => {
    const binaryPath = join(tempArchonHome, 'vendor-bin', 'codex');
    mkdirSync(join(tempArchonHome, 'vendor-bin'), { recursive: true });
    writeFileSync(binaryPath, 'codex binary');

    const hashPath = getTrustPinPath(binaryPath);
    mkdirSync(join(mockArchonHome, 'trust/codex'), { recursive: true });
    writeFileSync(hashPath, '0'.repeat(64) + '\n');

    expect(() => resolver.verifyOrPinBinaryHash(binaryPath)).toThrow('possible tampering detected');
    expect(mockLogger.error).toHaveBeenCalledWith(
      {
        binaryPath,
        hashPath,
        expected: '0'.repeat(64),
        actual: createHash('sha256').update('codex binary').digest('hex'),
      },
      'codex.binary_hash_mismatch'
    );
  });

  test('pins hash on first use into Archon trust directory instead of next to the binary', () => {
    const binaryContent = Buffer.from('codex binary');
    const binaryPath = join(tempArchonHome, 'vendor-bin', 'codex');
    mkdirSync(join(tempArchonHome, 'vendor-bin'), { recursive: true });
    writeFileSync(binaryPath, binaryContent);

    expect(() => resolver.verifyOrPinBinaryHash(binaryPath)).not.toThrow();
    expect(existsSync(binaryPath + '.sha256')).toBe(false);

    const expectedHash = createHash('sha256').update(binaryContent).digest('hex');
    expect(readFileSync(getTrustPinPath(binaryPath), 'utf8').trim()).toBe(expectedHash);
  });

  test('throws for malformed trust pin files without leaking their contents', () => {
    const binaryPath = join(tempArchonHome, 'vendor-bin', 'codex');
    mkdirSync(join(tempArchonHome, 'vendor-bin'), { recursive: true });
    writeFileSync(binaryPath, 'codex binary');

    const hashPath = getTrustPinPath(binaryPath);
    mkdirSync(join(mockArchonHome, 'trust/codex'), { recursive: true });
    writeFileSync(hashPath, 'secret-token');

    try {
      resolver.verifyOrPinBinaryHash(binaryPath);
      throw new Error('expected verifyOrPinBinaryHash to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('malformed');
      expect(message).not.toContain('secret-token');
    }
  });

  test.skipIf(process.platform === 'win32')(
    'detects swapped symlink target via logical-path pinning',
    () => {
      // Threat model: attacker can write inside the vendor binary directory.
      // If pins were keyed by realpath, swapping the symlink target to a
      // different file would change realpath, miss the existing pin, and
      // silently re-pin the new file. With logical-path keying, the pin file
      // for the binary's *logical* location persists and trips a mismatch.
      const symlinkBinaryPath = join(tempArchonHome, 'vendor-bin', 'codex');
      const realBinary1 = join(tempArchonHome, 'real1');
      const realBinary2 = join(tempArchonHome, 'real2');
      mkdirSync(join(tempArchonHome, 'vendor-bin'), { recursive: true });
      writeFileSync(realBinary1, 'codex binary v1');
      writeFileSync(realBinary2, 'EVIL replacement binary');
      symlinkSync(realBinary1, symlinkBinaryPath);

      // First use pins the hash of v1 keyed by the symlink's logical path.
      expect(() => resolver.verifyOrPinBinaryHash(symlinkBinaryPath)).not.toThrow();
      const expected1 = createHash('sha256').update('codex binary v1').digest('hex');
      expect(readFileSync(getTrustPinPath(symlinkBinaryPath), 'utf8').trim()).toBe(expected1);

      // Attacker swaps the symlink target. The logical path is unchanged, so
      // the pin file is found and verification trips a mismatch.
      rmSync(symlinkBinaryPath);
      symlinkSync(realBinary2, symlinkBinaryPath);
      expect(() => resolver.verifyOrPinBinaryHash(symlinkBinaryPath)).toThrow(
        'possible tampering detected'
      );
    }
  );

  test.skipIf(process.platform === 'win32')('refuses symlinked trust pin paths', () => {
    const binaryPath = join(tempArchonHome, 'vendor-bin', 'codex');
    mkdirSync(join(tempArchonHome, 'vendor-bin'), { recursive: true });
    writeFileSync(binaryPath, 'codex binary');

    const hashPath = getTrustPinPath(binaryPath);
    mkdirSync(join(mockArchonHome, 'trust/codex'), { recursive: true });
    const targetPath = join(tempArchonHome, 'outside.txt');
    writeFileSync(targetPath, 'not-a-real-pin');
    symlinkSync(targetPath, hashPath);

    expect(() => resolver.verifyOrPinBinaryHash(binaryPath)).toThrow('symlink');
  });

  test('memoizes verified logical paths within the process so the binary is hashed once', () => {
    const binaryPath = join(tempArchonHome, 'vendor-bin', 'codex');
    mkdirSync(join(tempArchonHome, 'vendor-bin'), { recursive: true });
    writeFileSync(binaryPath, 'codex binary');

    const readSpy = spyOn(resolver, 'readFile');
    try {
      // First call pins → hashes once.
      resolver.verifyOrPinBinaryHash(binaryPath);
      const callsAfterFirst = readSpy.mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      // Subsequent calls hit the in-process cache → no further reads.
      resolver.verifyOrPinBinaryHash(binaryPath);
      resolver.verifyOrPinBinaryHash(binaryPath);
      expect(readSpy.mock.calls.length).toBe(callsAfterFirst);

      // Reset clears the cache → next call re-hashes.
      resolver.resetVerifiedHashCacheForTests();
      resolver.verifyOrPinBinaryHash(binaryPath);
      expect(readSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    } finally {
      readSpy.mockRestore();
    }
  });

  test('cache invalidates when the binary mtime changes (long-lived process tamper detection)', () => {
    const binaryPath = join(tempArchonHome, 'vendor-bin', 'codex');
    mkdirSync(join(tempArchonHome, 'vendor-bin'), { recursive: true });
    writeFileSync(binaryPath, 'codex binary');

    // Pin the original binary.
    resolver.verifyOrPinBinaryHash(binaryPath);

    // Touch with a noticeably later mtime — simulates an in-place rewrite.
    const future = new Date(Date.now() + 60_000);
    utimesSync(binaryPath, future, future);

    const readSpy = spyOn(resolver, 'readFile');
    try {
      // Cache must miss (different stat fingerprint) → re-hash. Same content
      // so the pin still matches and the call returns cleanly.
      resolver.verifyOrPinBinaryHash(binaryPath);
      expect(readSpy).toHaveBeenCalled();

      // After the re-verify, the new fingerprint is cached → next call skips.
      const callsAfterRehash = readSpy.mock.calls.length;
      resolver.verifyOrPinBinaryHash(binaryPath);
      expect(readSpy.mock.calls.length).toBe(callsAfterRehash);
    } finally {
      readSpy.mockRestore();
    }
  });
});
