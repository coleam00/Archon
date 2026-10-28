import { dirname, join } from 'path';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import {
  createLogger,
  getWebDistDir,
  getServerDistDir,
  getSourceServerEntry,
  getLogLevel,
  getSourceWebDistDir,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  BUNDLED_WEB_DIST_SHA256,
  BUNDLED_SERVER_SHA256,
} from '@archon/paths';

import { serverLaunchArgv, serverReleaseAsset } from '@archon/paths/server-launch';

import { extractWebArchive } from './serve-web-archive';

const log = createLogger('cli.serve');

const GITHUB_REPO = 'coleam00/Archon';

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
  /** Download the server and web UI and exit without starting the server. */
  downloadOnly?: boolean;
}

type ServerChild = Pick<Bun.Subprocess, 'exited' | 'kill' | 'pid'>;
type SpawnServer = (
  argv: string[],
  options: Bun.SpawnOptions.OptionsObject<'inherit', 'inherit', 'inherit'>
) => ServerChild;

export async function serveCommand(
  opts: ServeOptions,
  spawn: SpawnServer = (argv, options) => Bun.spawn(argv, options)
): Promise<number> {
  if (
    opts.port !== undefined &&
    (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
  ) {
    console.error(`Error: --port must be an integer between 1 and 65535, got: ${opts.port}`);
    return 1;
  }

  // A source checkout builds the web UI locally instead of downloading it: there
  // is no release tagged `dev` to fetch from, and the tree already holds the
  // dist that `bun run build:web` produces.
  if (!BUNDLED_IS_BINARY) {
    return serveSourceCheckout(opts, spawn);
  }

  const version = BUNDLED_VERSION;
  const webDistDir = getWebDistDir(version);
  const asset = serverReleaseAsset(
    `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
  );
  const serverPath = join(getServerDistDir(version), asset);
  try {
    if (!existsSync(serverPath)) await downloadServer(version, serverPath, asset);
    else log.info({ serverPath }, 'server_dist.cache_hit');
  } catch (err) {
    log.error({ err: toError(err), version, serverPath }, 'server_dist.download_failed');
    console.error(`Error: Failed to download server: ${toError(err).message}`);
    console.error('Retry with: archon serve --download-only');
    return 1;
  }

  if (!existsSync(webDistDir)) {
    try {
      await downloadWebDist(version, webDistDir);
    } catch (err) {
      const error = toError(err);
      log.error({ err: error, version, webDistDir }, 'web_dist.download_failed');
      console.error(`Error: Failed to download web UI: ${error.message}`);
      console.error('Retry with: archon serve --download-only');
      return 1;
    }
  } else {
    log.info({ webDistDir }, 'web_dist.cache_hit');
  }

  if (opts.downloadOnly) {
    log.info({ webDistDir }, 'web_dist.download_completed');
    console.log(`Server downloaded to: ${serverPath}`);
    console.log(`Web UI downloaded to: ${webDistDir}`);
    return 0;
  }

  return launchServer([serverPath], webDistDir, opts.port, spawn);
}

async function launchServer(
  command: string[],
  webDistDir: string,
  port: number | undefined,
  spawn: SpawnServer
): Promise<number> {
  const ignoreInterrupt = (): void => undefined;
  let forwardTerminate: (() => void) | undefined;
  try {
    // Ctrl+C reaches the foreground process group. Forwarding it would interrupt
    // the server twice and cut its graceful shutdown short.
    process.on('SIGINT', ignoreInterrupt);
    const child = spawn(
      [
        ...command,
        ...serverLaunchArgv({
          cliVersion: BUNDLED_VERSION,
          port,
          webDistPath: webDistDir,
        }),
      ],
      {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env, LOG_LEVEL: getLogLevel() },
      }
    );
    forwardTerminate = (): void => {
      child.kill('SIGTERM');
    };
    process.once('SIGTERM', forwardTerminate);
    log.info({ serverPid: child.pid }, 'server.spawned');
    return await child.exited;
  } catch (err) {
    log.error({ err: toError(err), webDistDir, port }, 'server.start_failed');
    console.error(`Error: Server failed to start: ${toError(err).message}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', ignoreInterrupt);
    if (forwardTerminate) process.removeListener('SIGTERM', forwardTerminate);
  }
}

export async function downloadServer(
  version: string,
  serverPath: string,
  asset: string,
  embeddedChecksum: string = BUNDLED_SERVER_SHA256
): Promise<void> {
  log.info({ version, serverPath, asset }, 'server_dist.download_started');
  const bytes = await fetchVerifiedAsset(version, asset, embeddedChecksum, 'server_dist');
  mkdirSync(dirname(serverPath), { recursive: true });
  const staged = `${serverPath}.${process.pid}.tmp`;
  try {
    await Bun.write(staged, bytes);
    log.info({ staged, bytes: bytes.byteLength }, 'server_dist.staged');
    chmodSync(staged, 0o755);
    renameSync(staged, serverPath);
    log.info({ serverPath }, 'server_dist.installed');
  } finally {
    rmSync(staged, { force: true });
  }
}

async function fetchVerifiedAsset(
  version: string,
  asset: string,
  embeddedChecksum: string,
  phase: 'web_dist' | 'server_dist'
): Promise<ArrayBuffer> {
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${asset}`;
  try {
    let expectedHash: string;
    if (embeddedChecksum) expectedHash = parseEmbeddedChecksum(embeddedChecksum);
    else if (phase === 'web_dist') {
      // Development binary builds without a packaged web artifact retain the remote-checksum fallback.
      const checksumsUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/checksums.txt`;
      const checksums = await fetch(checksumsUrl);
      if (!checksums.ok)
        throw new Error(`Failed to download checksums from ${checksumsUrl}: ${checksums.status}`);
      expectedHash = parseChecksum(await checksums.text(), asset);
    } else {
      throw new Error('Missing embedded server checksum');
    }
    log.info({ source: embeddedChecksum ? 'embedded' : 'remote' }, `${phase}.checksum_resolved`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const size = response.headers.get('content-length');
    console.log(
      `Downloading ${asset} for Archon v${version} (${size ? `${size} bytes` : 'size unavailable'}) from ${url}...`
    );
    const bytes = await response.arrayBuffer();
    const actualHash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash)
      throw new Error(`Checksum mismatch: expected ${expectedHash}, got ${actualHash}`);
    console.log('Checksum verified.');
    log.info({ bytes: bytes.byteLength }, `${phase}.verified`);
    return bytes;
  } catch (error) {
    throw new Error(`${toError(error).message} (${url})`, { cause: error });
  }
}

// Exported for tests; `embeddedChecksum` defaults to the build-time constant so
// production callers never pass it explicitly.
export async function downloadWebDist(
  version: string,
  targetDir: string,
  embeddedChecksum: string = BUNDLED_WEB_DIST_SHA256
): Promise<void> {
  const downloadStartedAt = performance.now();
  log.info({ version, targetDir }, 'web_dist.download_started');
  const tarballBuffer = await fetchVerifiedAsset(
    version,
    'archon-web.tar.gz',
    embeddedChecksum,
    'web_dist'
  );
  const verifiedAt = performance.now();
  log.info({ durationMs: Math.round(verifiedAt - downloadStartedAt) }, 'web_dist.tarball_verified');

  // Extract to temp dir, then atomic rename
  const tmpDir = `${targetDir}.tmp`;

  // Clean up any previous failed attempt
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  let files: number;
  try {
    files = extractWebArchive(new Uint8Array(tarballBuffer), tmpDir);
  } catch (err) {
    cleanupAndThrow(tmpDir, toError(err).message);
  }
  const extractedAt = performance.now();
  log.info({ files, durationMs: Math.round(extractedAt - verifiedAt) }, 'web_dist.extracted');

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
  log.info(
    { targetDir, durationMs: Math.round(performance.now() - extractedAt) },
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

function serveSourceCheckout(opts: ServeOptions, spawn: SpawnServer): Promise<number> | number {
  const webDistDir = getSourceWebDistDir();

  if (opts.downloadOnly) {
    console.error(
      'Error: --download-only is for binary installs. A source checkout has nothing to download.'
    );
    console.error('Build the web UI instead: bun run build:web');
    return 1;
  }

  if (!existsSync(webDistDir)) {
    log.error({ webDistDir }, 'web_dist.source_build_missing');
    console.error(`Error: Web UI is not built at ${webDistDir}.`);
    console.error('Build it first: bun run build:web');
    return 1;
  }

  log.info({ webDistDir }, 'web_dist.source_build_found');
  return launchServer(
    [process.execPath, '--no-env-file', getSourceServerEntry()],
    webDistDir,
    opts.port,
    spawn
  );
}
