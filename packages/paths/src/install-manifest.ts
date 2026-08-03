/**
 * Best-effort persistence for locating the installed compiled Archon CLI.
 *
 * Consumers must treat this file as untrusted discovery metadata and validate
 * the executable before invoking it directly.
 */
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, resolve } from 'path';
import { getInstallManifestPath } from './archon-paths';
import { createLogger } from './logger';

const log = createLogger('install-manifest');

export type InstallMethod = 'curl' | 'powershell' | 'manual';

export interface InstallManifest {
  binary: string;
  version: string;
  installedAt: string;
  method: InstallMethod;
}

export interface WriteInstallManifestOptions {
  binary: string;
  version: string;
  method: InstallMethod;
}

function canonicalizeBinaryPath(binary: string): string {
  const absoluteBinary = resolve(binary);
  try {
    return realpathSync(absoluteBinary);
  } catch (err) {
    log.debug({ err, binary: absoluteBinary }, 'install_manifest.realpath_failed');
    return absoluteBinary;
  }
}

/** Persist a complete manifest atomically. All filesystem failures are non-fatal. */
export function writeInstallManifest(options: WriteInstallManifestOptions): void {
  let manifestPath: string | undefined;
  let tempPath: string | undefined;

  try {
    manifestPath = getInstallManifestPath();
    const manifestDir = dirname(manifestPath);
    tempPath = `${manifestPath}.${String(process.pid)}.${randomUUID()}.tmp`;
    const manifest: InstallManifest = {
      binary: canonicalizeBinaryPath(options.binary),
      version: options.version,
      installedAt: new Date().toISOString(),
      method: options.method,
    };
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(tempPath, manifestPath);
  } catch (err) {
    if (tempPath) {
      try {
        rmSync(tempPath, { force: true });
      } catch (cleanupError) {
        log.debug({ err: cleanupError, tempPath }, 'install_manifest.cleanup_failed');
      }
    }
    log.debug({ err, manifestPath }, 'install_manifest.write_failed');
  }
}

/** Refresh install discovery at startup without recording source/Bun invocations. */
export function refreshCompiledInstallManifest(
  isBinary: boolean,
  binary: string,
  version: string
): void {
  if (!isBinary) return;
  writeInstallManifest({ binary, version, method: 'manual' });
}
