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
import {
  serveCommand,
  parseChecksum,
  parseEmbeddedChecksum,
  downloadWebDist,
  resolveTarBin,
} from './serve';

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

describe('resolveTarBin', () => {
  // Windows ships bsdtar at System32\tar.exe, but Git for Windows puts GNU tar
  // on PATH ahead of it, and GNU tar cannot open a drive-letter operand: it
  // mangles the `-C C:\Users\...` operand into a colon-escaped path and exits 2.
  // Leaving the binary to PATH makes extraction depend on which shell launched
  // Archon, so these cases pin the choice on every host — CI runs them off Windows.
  const SYSTEM32_TAR = /[/\\]System32[/\\]tar\.exe$/;

  it('pins the Windows system tar when it is present', () => {
    const probed: string[] = [];

    const bin = resolveTarBin('win32', path => {
      probed.push(path);
      return true;
    });

    expect(bin).not.toBe('tar');
    expect(bin).toMatch(SYSTEM32_TAR);
    // The probe must ask about the path it returns, not some other file.
    expect(probed).toEqual([bin]);
  });

  it('falls back to PATH when Windows has no bundled tar', () => {
    // Pre-1803 Windows ships no tar. Returning the absolute path anyway would
    // spawn a file that does not exist, which is a worse failure than a PATH miss.
    expect(resolveTarBin('win32', () => false)).toBe('tar');
  });

  it('leaves the binary to PATH off Windows', () => {
    const probed: string[] = [];

    const bin = resolveTarBin('linux', path => {
      probed.push(path);
      return true;
    });

    expect(bin).toBe('tar');
    // No filesystem probe at all — the POSIX `tar` on PATH is the right one.
    expect(probed).toEqual([]);
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

  // The spawn-shape and cleanup assertions ride along here rather than in tests
  // of their own: each call to downloadWebDist costs a real `tar` spawn, and
  // spawn count on windows is the whole reason this file gets attention.
  it('verifies against the embedded hash without fetching checksums.txt', async () => {
    fetchSpy.mockImplementation(async () => new Response(tarballBytes));
    const targetDir = join(tmpRoot, 'target-embedded-ok');
    const spawnSpy = spyOn(Bun, 'spawn');
    let extractorStdin: unknown;
    let extractorBin: string | undefined;

    try {
      await downloadWebDist('9.9.9', targetDir, tarballHash);
      // Read before restoring — mockRestore() clears the recorded calls.
      extractorStdin = (spawnSpy.mock.calls[0]?.[1] as { stdin?: unknown } | undefined)?.stdin;
      extractorBin = (spawnSpy.mock.calls[0]?.[0] as string[] | undefined)?.[0];
    } finally {
      spawnSpy.mockRestore();
    }

    // Content, not just existence — a truncated or corrupt fixture still yields
    // an index.html and a `tar` exit 0, so only this assertion catches it.
    expect(readFileSync(join(targetDir, 'index.html'), 'utf8')).toBe(FIXTURE_INDEX_HTML);
    // Only the tarball is fetched — checksums.txt must NOT be requested.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('archon-web.tar.gz');
    // `tar` must inherit a file descriptor. Passing the bytes as `stdin` instead
    // leaves the parent owning a channel it has to pump and close, and a stalled
    // pump blocks `tar` forever — the windows hang in #2924. A BunFile is a Blob;
    // a Uint8Array is not, which is exactly the regression this catches.
    expect(extractorStdin).toBeInstanceOf(Blob);
    // Wiring: extraction must spawn the resolved binary, not the bare name. An
    // exported-but-uncalled resolver leaves Windows on PATH, which is the bug.
    if (process.platform === 'win32') {
      expect(extractorBin).toMatch(/[/\\]System32[/\\]tar\.exe$/);
    } else {
      expect(extractorBin).toBe('tar');
    }
    // The staged archive is ~2 MB in production — it must not survive extraction.
    expect(existsSync(`${targetDir}.tmp.tar.gz`)).toBe(false);
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
  // anything is staged, so it never leaves temp state behind. Checksum-valid
  // bytes that are not a gzip stream are the only cheap way in — staging happens,
  // then `tar` exits non-zero.
  it('leaves nothing behind when tar exits non-zero', async () => {
    const notAnArchive = new TextEncoder().encode('checksum-valid, but not gzip');
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(notAnArchive);
    fetchSpy.mockImplementation(async () => new Response(notAnArchive));
    const targetDir = join(tmpRoot, 'target-tar-failure');

    await expect(downloadWebDist('9.9.9', targetDir, hasher.digest('hex'))).rejects.toThrow(
      'tar extraction failed'
    );

    expect(existsSync(`${targetDir}.tmp.tar.gz`)).toBe(false);
    expect(existsSync(`${targetDir}.tmp`)).toBe(false);
    expect(existsSync(targetDir)).toBe(false);
  });

  // The bound is the only thing between a stuck `tar` and an `archon serve` that
  // waits forever, so it is proved against a child that genuinely never exits.
  // A fake subprocess would have to model kill-ends-the-wait, which is the part
  // worth doubting: this asserts it instead. The extra child is deliberate spawn
  // cost on windows (#2924) and it is bounded by the thing under test — 250ms,
  // then killed.
  it('bounds a stalled extraction, names the timeout, and leaves no partial tree', async () => {
    fetchSpy.mockImplementation(async () => new Response(tarballBytes));
    const targetDir = join(tmpRoot, 'target-extract-stall');
    const tmpDir = `${targetDir}.tmp`;
    const partialFile = join(tmpDir, 'index.html');
    const realSpawn = Bun.spawn.bind(Bun);
    let partialTreeExisted = false;
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((
      _command: string[],
      options: Parameters<typeof Bun.spawn>[1]
    ) => {
      // Written here, not by the child, so a half-extracted tree is present
      // before the stall rather than racing the timer for its own existence.
      writeFileSync(partialFile, 'half a tree');
      partialTreeExisted = existsSync(partialFile);
      // The child sleeps rather than spinning on a never-resolving promise. Its own 30s
      // bound is a backstop, not part of the assertion: the 250ms kill is what ends it on
      // every passing run, and anything past 250ms reads as "never exits" here. The backstop
      // matters when the runner is killed before that kill lands — the child is orphaned, and
      // a never-resolving promise would then hold a core at 100% until reboot (oven-sh/bun#14951).
      return realSpawn(
        [process.execPath, '-e', 'await new Promise(resolve => setTimeout(resolve, 30_000))'],
        options
      );
    }) as unknown as typeof Bun.spawn);

    try {
      await expect(downloadWebDist('9.9.9', targetDir, tarballHash, 250)).rejects.toThrow(
        /Timed out extracting the web UI: tar did not finish within 250ms/
      );
    } finally {
      spawnSpy.mockRestore();
    }

    expect(partialTreeExisted).toBe(true);
    // Nothing survives the bound: not the half-extracted tree, not the staged
    // archive, and above all no target dir that the next run would read as a
    // complete install.
    expect(existsSync(partialFile)).toBe(false);
    expect(existsSync(tmpDir)).toBe(false);
    expect(existsSync(`${targetDir}.tmp.tar.gz`)).toBe(false);
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
