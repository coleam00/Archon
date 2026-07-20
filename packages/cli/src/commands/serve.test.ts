import {
  describe,
  it,
  expect,
  mock,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @archon/paths BEFORE importing the module under test.
// This sets BUNDLED_IS_BINARY = false (dev mode) so serveCommand rejects.
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getWebDistDir: mock((version: string) => `/tmp/test-archon/web-dist/${version}`),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'dev',
  BUNDLED_WEB_DIST_SHA256: '',
}));

import { serveCommand, parseChecksum, parseEmbeddedChecksum, downloadWebDist } from './serve';

describe('parseChecksum', () => {
  const validHash = 'a'.repeat(64);

  it('should extract hash for matching filename', () => {
    const checksums = [
      `${'b'.repeat(64)}  archon-linux-x64`,
      `${validHash}  archon-web.tar.gz`,
      `${'c'.repeat(64)}  archon-darwin-arm64`,
    ].join('\n');

    expect(parseChecksum(checksums, 'archon-web.tar.gz')).toBe(validHash);
  });

  it('should handle single-space separator', () => {
    const checksums = `${validHash} archon-web.tar.gz\n`;
    expect(parseChecksum(checksums, 'archon-web.tar.gz')).toBe(validHash);
  });

  it('should throw for missing filename', () => {
    const checksums = `${validHash}  archon-linux-x64\n`;
    expect(() => parseChecksum(checksums, 'archon-web.tar.gz')).toThrow(
      'Checksum not found for archon-web.tar.gz'
    );
  });

  it('should throw for empty checksums text', () => {
    expect(() => parseChecksum('', 'archon-web.tar.gz')).toThrow('Checksum not found');
  });

  it('should skip blank lines', () => {
    const checksums = `\n${validHash}  archon-web.tar.gz\n\n`;
    expect(parseChecksum(checksums, 'archon-web.tar.gz')).toBe(validHash);
  });

  it('should throw for malformed hash (not 64 hex chars)', () => {
    const checksums = 'short_hash  archon-web.tar.gz\n';
    expect(() => parseChecksum(checksums, 'archon-web.tar.gz')).toThrow(
      'Malformed checksum entry for archon-web.tar.gz'
    );
  });

  it('should throw for uppercase hex hash', () => {
    const checksums = `${'A'.repeat(64)}  archon-web.tar.gz\n`;
    expect(() => parseChecksum(checksums, 'archon-web.tar.gz')).toThrow(
      'Malformed checksum entry for archon-web.tar.gz'
    );
  });
});

describe('parseEmbeddedChecksum', () => {
  const validHash = 'b'.repeat(64);

  it('should accept a lowercase 64-char hex checksum', () => {
    expect(parseEmbeddedChecksum(validHash)).toBe(validHash);
  });

  it('should trim surrounding whitespace before validation', () => {
    expect(parseEmbeddedChecksum(`  ${validHash}\n`)).toBe(validHash);
  });

  it('should reject malformed embedded checksums', () => {
    expect(() => parseEmbeddedChecksum('not-a-sha')).toThrow('Malformed embedded checksum');
  });
});

describe('downloadWebDist', () => {
  let tmpRoot: string;
  let tarballBytes: Uint8Array;
  let tarballHash: string;
  let fetchSpy: ReturnType<typeof spyOn>;
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    // Build a real tarball (one top-level dir with index.html — downloadWebDist
    // extracts with --strip-components=1) and compute its true SHA-256.
    tmpRoot = mkdtempSync(join(tmpdir(), 'serve-webdist-test-'));
    const srcDir = join(tmpRoot, 'web');
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, 'index.html'), '<html>ok</html>');
    const proc = Bun.spawn(['tar', 'czf', '-', '-C', tmpRoot, 'web'], { stdout: 'pipe' });
    tarballBytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(tarballBytes);
    tarballHash = hasher.digest('hex');
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it('verifies against the embedded hash without fetching checksums.txt', async () => {
    fetchSpy.mockImplementation(async () => new Response(tarballBytes));
    const targetDir = join(tmpRoot, 'target-embedded-ok');

    await downloadWebDist('9.9.9', targetDir, tarballHash);

    expect(existsSync(join(targetDir, 'index.html'))).toBe(true);
    // Only the tarball is fetched — checksums.txt must NOT be requested.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('archon-web.tar.gz');
  });

  it('hard-fails on embedded hash mismatch with a clear error', async () => {
    fetchSpy.mockImplementation(async () => new Response(tarballBytes));
    const targetDir = join(tmpRoot, 'target-embedded-mismatch');
    const wrongHash = 'c'.repeat(64);

    await expect(downloadWebDist('9.9.9', targetDir, wrongHash)).rejects.toThrow(
      `Checksum mismatch: expected ${wrongHash}, got ${tarballHash}`
    );
    expect(existsSync(targetDir)).toBe(false);
    // Still no checksums.txt fetch on the embedded path.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to remote checksums.txt when the embedded hash is empty', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes('checksums.txt')) {
        return new Response(`${tarballHash}  archon-web.tar.gz\n`);
      }
      return new Response(tarballBytes);
    });
    const targetDir = join(tmpRoot, 'target-remote-fallback');

    await downloadWebDist('9.9.9', targetDir, '');

    expect(existsSync(join(targetDir, 'index.html'))).toBe(true);
    // Remote path fetches both checksums.txt and the tarball.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map(call => String(call[0]));
    expect(urls.some(u => u.includes('checksums.txt'))).toBe(true);
  });
});

describe('serveCommand', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should reject in dev mode (non-binary)', async () => {
    const exitCode = await serveCommand({});
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Error: `archon serve` is for compiled binaries only.'
    );
  });

  it('should reject with downloadOnly in dev mode', async () => {
    const exitCode = await serveCommand({ downloadOnly: true });
    expect(exitCode).toBe(1);
  });

  it('should reject invalid port (NaN)', async () => {
    const exitCode = await serveCommand({ port: NaN });
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('--port must be an integer between 1 and 65535')
    );
  });

  it('should reject port out of range', async () => {
    const exitCode = await serveCommand({ port: 99999 });
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('--port must be an integer between 1 and 65535')
    );
  });

  it('should reject port 0', async () => {
    const exitCode = await serveCommand({ port: 0 });
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('--port must be an integer between 1 and 65535')
    );
  });
});
