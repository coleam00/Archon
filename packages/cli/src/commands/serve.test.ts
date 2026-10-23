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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildWebTarball, FIXTURE_INDEX_HTML } from '../test-support/web-tarball';

// Mock @archon/paths BEFORE importing the module under test.
// BUNDLED_IS_BINARY = false puts serveCommand on its source-checkout path, and
// getSourceWebDistDir is redirected at a temp tree so a test can decide whether
// `bun run build:web` has been run without depending on this checkout's state.
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
let sourceWebDistDir = '/tmp/test-archon/unset-source-web-dist';
const paths = { ...(await import('@archon/paths')) };
mock.module('@archon/paths', () => ({
  ...paths,
  createLogger: mock(() => mockLogger),
  getWebDistDir: mock((version: string) => `/tmp/test-archon/web-dist/${version}`),
  getServerDistDir: mock((version: string) => `/tmp/test-archon/server/${version}`),
  getSourceServerEntry: () => '/checkout/packages/server/src/bin.ts',
  getLogLevel: () => 'debug',
  getSourceWebDistDir: mock(() => sourceWebDistDir),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'dev',
  BUNDLED_WEB_DIST_SHA256: '',
  BUNDLED_SERVER_SHA256: '',
}));

import { trackTempRoots, removeTempTree } from '@archon/paths/test-utils';
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

  afterAll(async () => {
    await removeTempTree(tmpRoot);
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
    const spawnSpy = spyOn(Bun, 'spawn');
    let spawnCalls: number;

    try {
      await downloadWebDist('9.9.9', targetDir, tarballHash);
      // Read before restoring — mockRestore() clears the recorded calls.
      spawnCalls = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }

    // Content, not just existence — a truncated or corrupt fixture still yields
    // an index.html, so only this assertion catches it.
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe(FIXTURE_INDEX_HTML);
    // Only the tarball is fetched — checksums.txt must NOT be requested.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('archon-web.tar.gz');
    // Extraction runs in-process: a `tar` child stalled on windows (#2924).
    expect(spawnCalls).toBe(0);
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

  // The mismatch test above cannot reach this path: verification runs before
  // the temp dir exists, so it never leaves temp state behind. Checksum-valid
  // bytes that are not a gzip stream are the only cheap way in — the temp dir is
  // created, then the archive cannot be read.
  it('leaves nothing behind when the archive cannot be read', async () => {
    const notAnArchive = new TextEncoder().encode('checksum-valid, but not gzip');
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(notAnArchive);
    fetchSpy.mockImplementation(async () => new Response(notAnArchive));
    const targetDir = join(tmpRoot, 'target-tar-failure');

    await expect(downloadWebDist('9.9.9', targetDir, hasher.digest('hex'))).rejects.toThrow(
      'Failed to read the web UI archive'
    );

    expect(existsSync(`${targetDir}.tmp`)).toBe(false);
    expect(existsSync(targetDir)).toBe(false);
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
    const urls = fetchSpy.mock.calls.map((call: Parameters<typeof fetch>) => String(call[0]));
    expect(urls.some((url: string) => url.includes('checksums.txt'))).toBe(true);
  });
});

// Structural conformance of the hand-rolled archive, checked against the POSIX
// ustar spec rather than against the writer itself.
//
// The extraction tests above catch a wrong *payload* (a short `size` field
// truncates the file, which the content assertions see). They do NOT catch a
// wrong *envelope*: the reader, like tar, stops at the end of data, so an
// archive with no end-of-archive marker or no final block padding still
// extracts cleanly. Hence these two.
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

const signals = ['SIGINT', 'SIGTERM'] as const;
function listeners() {
  return signals.map(signal => process.listeners(signal));
}

function fakeChild(exitCode = 0) {
  const kill = mock((_signal?: number | NodeJS.Signals) => {});
  return { pid: 1234, exited: Promise.resolve(exitCode), kill };
}

describe('serveCommand in a source checkout', () => {
  const trackTempRoot = trackTempRoots();
  let builtDist: string;
  let fetchSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    builtDist = trackTempRoot(mkdtempSync(join(tmpdir(), 'serve-source-dist-')));
    writeFileSync(join(builtDist, 'index.html'), '<html>built</html>');
    sourceWebDistDir = builtDist;
    fetchSpy = spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async () => {
      throw new Error('source checkout must not fetch');
    });
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
  it('spawns the source server with launch overrides, inherited stdio and CLI env', async () => {
    const before = listeners();
    const child = fakeChild(7);
    const spawn = mock(
      (
        _argv: string[],
        _options: Bun.SpawnOptions.OptionsObject<'inherit', 'inherit', 'inherit'>
      ) => child
    );
    expect(await serveCommand({ port: 4321 }, spawn)).toBe(7);
    expect(spawn).toHaveBeenCalledWith(
      [
        process.execPath,
        '--no-env-file',
        '/checkout/packages/server/src/bin.ts',
        '--cli-version',
        'dev',
        '--port',
        '4321',
        '--web-dist',
        builtDist,
      ],
      {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env, LOG_LEVEL: 'debug' },
      }
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listeners()).toEqual(before);
  });
  it('leaves SIGINT to the foreground group and forwards SIGTERM once to the recorded child', async () => {
    const before = listeners();
    let finish!: (code: number) => void;
    const child = {
      ...fakeChild(),
      exited: new Promise<number>(resolve => {
        finish = resolve;
      }),
    };
    const pending = serveCommand({}, () => child);
    for (const [index, signal] of signals.entries()) {
      const added = process.listeners(signal).filter(listener => !before[index].includes(listener));
      expect(added).toHaveLength(1);
      for (const listener of added) listener(signal);
      if (signal === 'SIGINT') expect(child.kill).not.toHaveBeenCalled();
    }
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledTimes(1);
    finish(0);
    expect(await pending).toBe(0);
    expect(listeners()).toEqual(before);
  });
  it('reports spawn failure and removes signal handlers', async () => {
    const before = listeners();
    expect(
      await serveCommand({}, () => {
        throw new Error('spawn refused');
      })
    ).toBe(1);
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).toContain('spawn refused');
    expect(listeners()).toEqual(before);
  });
  it('refuses with a build instruction when the dist is missing', async () => {
    sourceWebDistDir = join(builtDist, 'missing');
    const spawn = mock(
      (
        _argv: string[],
        _options: Bun.SpawnOptions.OptionsObject<'inherit', 'inherit', 'inherit'>
      ) => fakeChild()
    );
    expect(await serveCommand({}, spawn)).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).toContain('bun run build:web');
  });
  it('refuses --download-only in source mode', async () => {
    const spawn = mock(
      (
        _argv: string[],
        _options: Bun.SpawnOptions.OptionsObject<'inherit', 'inherit', 'inherit'>
      ) => fakeChild()
    );
    expect(await serveCommand({ downloadOnly: true }, spawn)).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
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
