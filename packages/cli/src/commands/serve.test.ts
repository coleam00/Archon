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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
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

// ---------------------------------------------------------------------------
// In-process tar.gz fixture builder.
//
// downloadWebDist shells out to `tar xzf -`, so the fixture it is fed has to be
// a genuine gzipped tar — but BUILDING that fixture does not need a subprocess.
// Spawning `tar czf -` here used to make the beforeAll hook the one thing in
// this file that could hang on a child process, which is exactly how it failed
// on windows CI (#2306). Emitting the ~1.1 KB ustar archive directly is
// deterministic, platform-independent, and needs no `tar` on PATH.
// ---------------------------------------------------------------------------

/** Write ASCII into a fixed-width header field (NUL padding comes from the zeroed buffer). */
function writeField(header: Uint8Array, offset: number, value: string, width: number): void {
  header.set(new TextEncoder().encode(value).subarray(0, width), offset);
}

/** Write a ustar numeric field: zero-padded octal followed by a trailing NUL. */
function writeOctalField(header: Uint8Array, offset: number, value: number, width: number): void {
  writeField(header, offset, value.toString(8).padStart(width - 1, '0'), width - 1);
}

/** One 512-byte ustar header block. `typeflag` is '0' (file) or '5' (directory). */
function tarHeader(name: string, size: number, typeflag: '0' | '5', mode: number): Uint8Array {
  const header = new Uint8Array(512);
  writeField(header, 0, name, 100);
  writeOctalField(header, 100, mode, 8);
  writeOctalField(header, 108, 0, 8); // uid
  writeOctalField(header, 116, 0, 8); // gid
  writeOctalField(header, 124, size, 12);
  writeOctalField(header, 136, 0, 12); // mtime — fixed so the fixture is byte-stable
  header.fill(0x20, 148, 156); // checksum field reads as 8 spaces while summing
  header[156] = typeflag.charCodeAt(0);
  writeField(header, 257, 'ustar', 6); // magic (NUL-terminated by the zeroed buffer)
  writeField(header, 263, '00', 2); // version
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeField(header, 148, checksum.toString(8).padStart(6, '0'), 6);
  header[154] = 0x00;
  header[155] = 0x20;
  return header;
}

/** Concatenate blocks into one buffer. */
function concatBytes(blocks: Uint8Array[]): Uint8Array {
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/**
 * The exact bytes the fixture claims to carry. Every test that extracts asserts
 * the file lands with THIS content, not merely that a file exists — a hand-rolled
 * binary format that nothing validates is a worse trap than the hang it replaced.
 * A `size` field short by a few bytes, dropped padding, or a missing terminator
 * all still produce an `index.html` and a `tar` exit 0; only comparing content
 * catches them.
 */
const FIXTURE_INDEX_HTML = '<html>ok</html>';

/** `web/` + `web/index.html`, tarred and gzipped — the shape `archon serve` downloads. */
function buildWebTarball(indexHtml: string): Uint8Array {
  const body = new TextEncoder().encode(indexHtml);
  const padding = new Uint8Array((512 - (body.length % 512)) % 512);
  return Bun.gzipSync(
    concatBytes([
      tarHeader('web/', 0, '5', 0o755),
      tarHeader('web/index.html', body.length, '0', 0o644),
      body,
      padding,
      new Uint8Array(1024), // two zero blocks terminate the archive
    ])
  );
}

describe('downloadWebDist', () => {
  let tmpRoot: string;
  let tarballBytes: Uint8Array;
  let tarballHash: string;
  let fetchSpy: ReturnType<typeof spyOn>;
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    // Fixture: a real gzipped tar with one top-level dir holding index.html —
    // downloadWebDist extracts with --strip-components=1. Built in-process
    // (see buildWebTarball) rather than by shelling out to `tar czf -`, so the
    // hook cannot hang on a subprocess (#2306).
    tmpRoot = mkdtempSync(join(tmpdir(), 'serve-webdist-test-'));
    tarballBytes = buildWebTarball(FIXTURE_INDEX_HTML);
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

    // Content, not just existence — a truncated or corrupt fixture still yields
    // an index.html and a `tar` exit 0, so only this assertion catches it.
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe(FIXTURE_INDEX_HTML);
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

    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe(FIXTURE_INDEX_HTML);
    // Remote path fetches both checksums.txt and the tarball.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map(call => String(call[0]));
    expect(urls.some(u => u.includes('checksums.txt'))).toBe(true);
  });
});

// Structural conformance of the hand-rolled archive, checked against the POSIX
// ustar spec rather than against the writer itself.
//
// The extraction tests above catch a wrong *payload* (a short `size` field
// truncates the file, which the content assertions see). They do NOT catch a
// wrong *envelope*: bsdtar happily extracts an archive with no end-of-archive
// marker and no block padding, so on macOS those corruptions pass silently and
// would only surface as a platform-specific CI failure — precisely the class of
// bug this file is being changed to remove. Hence these two.
describe('buildWebTarball structural conformance', () => {
  const archive = Bun.gunzipSync(buildWebTarball(FIXTURE_INDEX_HTML));

  it('is a whole number of 512-byte blocks', () => {
    expect(archive.length % 512).toBe(0);
  });

  it('ends with the two zero blocks that mark end-of-archive', () => {
    const terminator = archive.subarray(archive.length - 1024);
    expect(terminator.length).toBe(1024);
    expect(terminator.every(byte => byte === 0)).toBe(true);
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
