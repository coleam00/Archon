import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { createLogger, getWebDistDir, BUNDLED_IS_BINARY, BUNDLED_VERSION } from '@archon/paths';

const log = createLogger('cli.serve');

const GITHUB_REPO = 'coleam00/Archon';

export interface ServeOptions {
  port?: number;
  downloadOnly?: boolean;
}

export async function serveCommand(opts: ServeOptions): Promise<number> {
  const version = BUNDLED_IS_BINARY ? BUNDLED_VERSION : 'dev';

  if (version === 'dev') {
    console.error('Error: `archon serve` is for compiled binaries only.');
    console.error('For development, use: bun run dev');
    return 1;
  }

  const webDistDir = getWebDistDir(version);

  if (!existsSync(webDistDir)) {
    await downloadWebDist(version, webDistDir);
  } else {
    log.info({ webDistDir }, 'web_dist.cache_hit');
  }

  if (opts.downloadOnly) {
    log.info({ webDistDir }, 'web_dist.download_completed');
    console.log(`Web UI downloaded to: ${webDistDir}`);
    return 0;
  }

  // Import server and start (dynamic import keeps CLI startup fast for other commands)
  const { startServer } = await import('@archon/server');
  await startServer({
    webDistPath: webDistDir,
    port: opts.port,
    skipPlatformAdapters: false,
  });

  // Server runs until SIGINT/SIGTERM — never returns
  return 0;
}

async function downloadWebDist(version: string, targetDir: string): Promise<void> {
  const tarballUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/archon-web.tar.gz`;
  const checksumsUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/checksums.txt`;

  console.log(`Web UI not found locally — downloading from release v${version}...`);

  // Download checksums
  const checksumsRes = await fetch(checksumsUrl);
  if (!checksumsRes.ok) {
    throw new Error(
      `Failed to download checksums: ${checksumsRes.status} ${checksumsRes.statusText}`
    );
  }
  const checksumsText = await checksumsRes.text();
  const expectedHash = parseChecksum(checksumsText, 'archon-web.tar.gz');

  // Download tarball
  console.log(`Downloading ${tarballUrl}...`);
  const tarballRes = await fetch(tarballUrl);
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
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`tar extraction failed with exit code ${exitCode}`);
  }

  // Atomic move into place
  mkdirSync(targetDir.substring(0, targetDir.lastIndexOf('/')), { recursive: true });
  renameSync(tmpDir, targetDir);
  console.log(`Extracted to ${targetDir}`);
}

/**
 * Parse a SHA-256 checksum from a checksums.txt file (sha256sum format).
 * Format: `<hash>  <filename>` or `<hash> <filename>`
 */
export function parseChecksum(checksums: string, filename: string): string {
  for (const line of checksums.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === filename) {
      return parts[0];
    }
  }
  throw new Error(`Checksum not found for ${filename} in checksums.txt`);
}
