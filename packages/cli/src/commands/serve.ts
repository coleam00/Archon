import { dirname } from 'path';
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import {
  createLogger,
  getWebDistDir,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  BUNDLED_WEB_DIST_SHA256,
} from '@archon/paths';

const log = createLogger('cli.serve');

const GITHUB_REPO = 'coleam00/Archon';

/**
 * Upper bound on the `tar` child. Extracting the ~2 MB release archive takes
 * tens of milliseconds, so this leaves three orders of magnitude of headroom for
 * a slow disk. Its only job is to stop a stalled child from turning
 * `archon serve` into a silent permanent hang: the parent-owned stdin channel
 * that caused the observed stall is gone (#2924), but filesystem-side stalls on
 * windows were never ruled out, and there is no budget in production to end one.
 */
const EXTRACTION_TIMEOUT_MS = 60_000;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function parseEmbeddedChecksum(checksum: string): string {
  const normalized = checksum.trim();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Malformed embedded checksum: "${checksum}"`);
  }
  return normalized;
}

export interface ServeOptions {
  /** TCP port to bind. Ignored when downloadOnly is true. Range: 1–65535. */
  port?: number;
  /** Download the web UI and exit without starting the server. */
  downloadOnly?: boolean;
}

export async function serveCommand(opts: ServeOptions): Promise<number> {
  if (
    opts.port !== undefined &&
    (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
  ) {
    console.error(`Error: --port must be an integer between 1 and 65535, got: ${opts.port}`);
    return 1;
  }

  if (!BUNDLED_IS_BINARY) {
    console.error('Error: `archon serve` is for compiled binaries only.');
    console.error('For development, use: bun run dev');
    return 1;
  }

  const version = BUNDLED_VERSION;
  const webDistDir = getWebDistDir(version);

  if (!existsSync(webDistDir)) {
    try {
      await downloadWebDist(version, webDistDir);
    } catch (err) {
      const error = toError(err);
      log.error({ err: error, version, webDistDir }, 'web_dist.download_failed');
      console.error(`Error: Failed to download web UI: ${error.message}`);
      return 1;
    }
  } else {
    log.info({ webDistDir }, 'web_dist.cache_hit');
  }

  if (opts.downloadOnly) {
    log.info({ webDistDir }, 'web_dist.download_completed');
    console.log(`Web UI downloaded to: ${webDistDir}`);
    return 0;
  }

  // Import server and start (dynamic import keeps CLI startup fast for other commands)
  try {
    const { startServer } = await import('@archon/server');
    await startServer({
      webDistPath: webDistDir,
      port: opts.port,
    });
  } catch (err) {
    const error = toError(err);
    log.error({ err: error, version, webDistDir, port: opts.port }, 'server.start_failed');
    console.error(`Error: Server failed to start: ${error.message}`);
    return 1;
  }

  // Block forever — Bun.serve() keeps the event loop alive, but the CLI's
  // process.exit(exitCode) would kill it. Wait on a promise that only resolves
  // on SIGINT/SIGTERM so the server stays running.
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  return 0;
}

// Exported for tests; `embeddedChecksum` defaults to the build-time constant so
// production callers never pass it explicitly.
export async function downloadWebDist(
  version: string,
  targetDir: string,
  embeddedChecksum: string = BUNDLED_WEB_DIST_SHA256
): Promise<void> {
  const tarballUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/archon-web.tar.gz`;
  const checksumsUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/checksums.txt`;

  // Phase markers, not metrics. When this stalls on windows CI the only surviving
  // evidence is the log, and a single start line cannot say whether the wait sat
  // in the fetch, the staged write, the spawn call, the child, or the rename
  // afterwards (#2924). Each `web_dist.*` event below closes one phase and
  // carries that phase's own durationMs, so the phases chain from here.
  const downloadStartedAt = performance.now();
  log.info({ version, targetDir }, 'web_dist.download_started');
  console.log(`Web UI not found locally — downloading from release v${version}...`);

  // Determine expected hash: prefer build-time embedded hash (independent trust anchor)
  // over the remote checksums.txt (same-source, weaker guarantee).
  let expectedHash: string;
  let tarballRes: Response;
  if (embeddedChecksum) {
    expectedHash = parseEmbeddedChecksum(embeddedChecksum);
    log.info({ source: 'embedded' }, 'web_dist.checksum_resolved');
    console.log(`Downloading ${tarballUrl}...`);
    tarballRes = await fetch(tarballUrl).catch((err: unknown) => {
      throw new Error(`Network error fetching tarball from ${tarballUrl}: ${toError(err).message}`);
    });
  } else {
    // Fallback: download checksums and tarball in parallel (dev mode or pre-build binaries)
    console.log(`Downloading ${tarballUrl}...`);
    const [checksumsRes, fetchedTarballRes] = await Promise.all([
      fetch(checksumsUrl).catch((err: unknown) => {
        throw new Error(
          `Network error fetching checksums from ${checksumsUrl}: ${toError(err).message}`
        );
      }),
      fetch(tarballUrl).catch((err: unknown) => {
        throw new Error(
          `Network error fetching tarball from ${tarballUrl}: ${toError(err).message}`
        );
      }),
    ]);
    if (!checksumsRes.ok) {
      throw new Error(
        `Failed to download checksums: ${checksumsRes.status} ${checksumsRes.statusText}`
      );
    }
    const checksumsText = await checksumsRes.text();
    expectedHash = parseChecksum(checksumsText, 'archon-web.tar.gz');
    log.info({ source: 'remote' }, 'web_dist.checksum_resolved');
    tarballRes = fetchedTarballRes;
  }

  if (!tarballRes.ok) {
    throw new Error(`Failed to download web UI: ${tarballRes.status} ${tarballRes.statusText}`);
  }
  const tarballBuffer = await tarballRes.arrayBuffer();

  // Verify checksum
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(new Uint8Array(tarballBuffer));
  const actualHash = hasher.digest('hex');

  if (actualHash !== expectedHash) {
    throw new Error(`Checksum mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
  console.log('Checksum verified.');
  const verifiedAt = performance.now();
  log.info({ durationMs: Math.round(verifiedAt - downloadStartedAt) }, 'web_dist.tarball_verified');

  // Extract to temp dir, then atomic rename
  const tmpDir = `${targetDir}.tmp`;
  const tarballPath = `${tmpDir}.tar.gz`;

  // Clean up any previous failed attempt
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // Stage the archive on disk so `tar` inherits a file descriptor. Passing the
  // bytes as `stdin` instead makes the parent own a channel it has to pump and
  // close, and on windows that pump can stall with no upper bound: two spawns in
  // one process sat with `tar` blocked on an unfed stdin until the test runner
  // killed them, on a runner where the same extraction took 16 ms minutes later
  // (#2924). Reading `-` keeps the archive path off the command line, where a
  // windows drive letter is ambiguous with `tar`'s own `host:path` syntax.
  await Bun.write(tarballPath, tarballBuffer);
  const extractionStartedAt = performance.now();
  // Covers the temp-dir reset above as well as the write — both are filesystem
  // work on the extraction target, and a stall there is indistinguishable from a
  // stall in `tar` without this boundary.
  log.info(
    {
      tarballPath,
      bytes: tarballBuffer.byteLength,
      durationMs: Math.round(extractionStartedAt - verifiedAt),
    },
    'web_dist.archive_staged'
  );
  // Only read after a clean `tar` exit, so the throw paths never see the seed.
  let extractionEndedAt = extractionStartedAt;
  try {
    const proc = Bun.spawn(['tar', 'xzf', '-', '-C', tmpDir, '--strip-components=1'], {
      stdin: Bun.file(tarballPath),
      stderr: 'pipe',
      timeout: EXTRACTION_TIMEOUT_MS,
    });
    // Separate from the wait below because process creation is a real share of
    // the cost, not a rounding error: on a healthy windows run the spawn call is
    // 24ms against the child's 133ms, so folding them together would hide a
    // stalled `CreateProcess` behind a slow-looking `tar`.
    // `tarPid`, not `pid` — pino already binds the parent's pid at the root, and
    // a second `pid` key would silently win on parse.
    const spawnedAt = performance.now();
    log.info(
      { tarPid: proc.pid, durationMs: Math.round(spawnedAt - extractionStartedAt) },
      'web_dist.extract_spawned'
    );
    // Drain stderr while waiting rather than after: a pipe nobody reads is the
    // same deadlock in the other direction once `tar` fills its buffer. Record
    // each completion separately: the combined wait has exceeded five seconds
    // on Windows without revealing whether the child or its pipe was delayed.
    const [exitCode, stderrText] = await Promise.all([
      proc.exited.then(exitCode => {
        log.info(
          { tarPid: proc.pid, exitCode, durationMs: Math.round(performance.now() - spawnedAt) },
          'web_dist.extract_process_exited'
        );
        return exitCode;
      }),
      new Response(proc.stderr).text().then(stderr => {
        log.info(
          { tarPid: proc.pid, durationMs: Math.round(performance.now() - spawnedAt) },
          'web_dist.extract_stderr_drained'
        );
        return stderr;
      }),
    ]);
    extractionEndedAt = performance.now();
    log.info(
      {
        exitCode,
        signalCode: proc.signalCode,
        durationMs: Math.round(extractionEndedAt - spawnedAt),
      },
      'web_dist.extract_exited'
    );
    const details = stderrText.trim();
    // A signal means `tar` never finished. `proc.killed` cannot say so — it is
    // true after any exit — and a signal can also come from outside this process,
    // so report how long it actually ran instead of asserting the bound fired.
    if (proc.signalCode !== null) {
      const elapsedMs = Math.round(extractionEndedAt - extractionStartedAt);
      cleanupAndThrow(
        tmpDir,
        `tar extraction was killed by ${proc.signalCode} after ${elapsedMs}ms without finishing ` +
          `(limit ${EXTRACTION_TIMEOUT_MS}ms): ${details}`
      );
    }
    if (exitCode !== 0) {
      cleanupAndThrow(tmpDir, `tar extraction failed (exit ${exitCode}): ${details}`);
    }
  } finally {
    rmSync(tarballPath, { force: true });
  }

  // Verify extraction produced expected layout
  if (!existsSync(`${tmpDir}/index.html`)) {
    cleanupAndThrow(
      tmpDir,
      'Extraction produced unexpected layout — index.html not found in extracted dir'
    );
  }

  // Atomic move into place
  mkdirSync(dirname(targetDir), { recursive: true });
  try {
    renameSync(tmpDir, targetDir);
  } catch (err) {
    cleanupAndThrow(
      tmpDir,
      `Failed to move extracted web UI from ${tmpDir} to ${targetDir}: ${toError(err).message}`
    );
  }
  // Closes the last phase: staged-archive removal, layout check, and the rename
  // of a freshly written tree — all after-tar filesystem work.
  log.info(
    { targetDir, durationMs: Math.round(performance.now() - extractionEndedAt) },
    'web_dist.installed'
  );
  console.log(`Extracted to ${targetDir}`);
}

function cleanupAndThrow(tmpDir: string, message: string): never {
  rmSync(tmpDir, { recursive: true, force: true });
  throw new Error(message);
}

/**
 * Parse a SHA-256 checksum from a checksums.txt file (sha256sum format).
 * Format: `<hash>  <filename>` or `<hash> <filename>`
 */
export function parseChecksum(checksums: string, filename: string): string {
  for (const line of checksums.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === filename) {
      const hash = parts[0];
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new Error(`Malformed checksum entry for ${filename}: "${line.trim()}"`);
      }
      return hash;
    }
  }
  throw new Error(`Checksum not found for ${filename} in checksums.txt`);
}
