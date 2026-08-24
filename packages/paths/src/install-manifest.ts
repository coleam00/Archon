/** Best-effort discovery metadata for the last compiled Archon CLI invoked. */
import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { getInstallManifestPath } from './archon-paths';
import { createLogger } from './logger';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('install-manifest');
  return cachedLog;
}

export interface InstallManifest {
  binary: string;
  version: string;
}

function canonicalizeBinaryPath(binary: string): string {
  const absoluteBinary = resolve(binary);
  try {
    return realpathSync(absoluteBinary);
  } catch (err) {
    getLog().debug({ err, binary: absoluteBinary }, 'install_manifest.realpath_failed');
    return absoluteBinary;
  }
}

function readCurrentManifest(path: string): InstallManifest | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.binary !== 'string' ||
      typeof record.version !== 'string'
    ) {
      return null;
    }

    return { binary: record.binary, version: record.version };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') getLog().debug({ err, path }, 'install_manifest.read_failed');
    return null;
  }
}

/**
 * Record this invocation when it is a compiled binary. Source/Bun runs and all
 * filesystem failures are no-ops so discovery metadata cannot block the CLI.
 */
export function refreshCompiledInstallManifest(
  isBinary: boolean,
  binary: string,
  version: string
): void {
  if (!isBinary) return;

  let manifestPath: string | undefined;
  let tempPath: string | undefined;

  try {
    manifestPath = getInstallManifestPath();
    const manifest: InstallManifest = {
      binary: canonicalizeBinaryPath(binary),
      version,
    };
    const current = readCurrentManifest(manifestPath);
    if (current?.binary === manifest.binary && current.version === manifest.version) return;

    mkdirSync(dirname(manifestPath), { recursive: true });
    tempPath = `${manifestPath}.${String(process.pid)}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(tempPath, manifestPath);
  } catch (err) {
    if (tempPath) {
      try {
        rmSync(tempPath, { force: true });
      } catch (cleanupError) {
        getLog().debug({ err: cleanupError, tempPath }, 'install_manifest.cleanup_failed');
      }
    }
    getLog().debug({ err, manifestPath }, 'install_manifest.write_failed');
  }
}
