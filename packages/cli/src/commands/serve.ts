import { dirname } from 'path';
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { createLogger, getWebDistDir, BUNDLED_IS_BINARY, BUNDLED_VERSION } from '@archon/paths';

const log = createLogger('cli.serve');

const GITHUB_REPO = 'coleam00/Archon';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
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

async function downloadWebDist(version: string, targetDir: string): Promise<void> {
  const tarballUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/archon-web.tar.gz`;
  const checksumsUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/checksums.txt`;

  log.info({ version, targetDir }, 'web_dist.download_started');
  console.log(`Web UI not found locally — downloading from release v${version}...`);

  // Download checksums
  const checksumsRes = await fetch(checksumsUrl).catch((err: unknown) => {
    throw new Error(
      `Network error fetching checksums from ${checksumsUrl}: ${(err as Error).message}`
    );
  });
  if (!checksumsRes.ok) {
    throw new Error(
      `Failed to download checksums: ${checksumsRes.status} ${checksumsRes.statusText}`
    );
  }
  const checksumsText = await checksumsRes.text();
  const expectedHash = parseChecksum(checksumsText, 'archon-web.tar.gz');

  // Download tarball
  console.log(`Downloading ${tarballUrl}...`);
  const tarballRes = await fetch(tarballUrl).catch((err: unknown) => {
    throw new Error(`Network error fetching tarball from ${tarballUrl}: ${(err as Error).message}`);
  });
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

  // Extract to temp dir, then atomic rename
  const tmpDir = `${targetDir}.tmp`;

  // Clean up any previous failed attempt
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // Extract tarball using tar (available on macOS/Linux)
  const proc = Bun.spawn(['tar', 'xzf', '-', '-C', tmpDir, '--strip-components=1'], {
    stdin: new Uint8Array(tarballBuffer),
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderrText = await new Response(proc.stderr).text();
    cleanupAndThrow(tmpDir, `tar extraction failed (exit ${exitCode}): ${stderrText.trim()}`);
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
      `Failed to move extracted web UI from ${tmpDir} to ${targetDir}: ${(err as Error).message}`
    );
  }
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
