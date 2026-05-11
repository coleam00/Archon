/**
 * Version command - displays version info
 *
 * For compiled binaries, version and git commit are embedded via `@archon/paths`
 * build-time constants (rewritten by `scripts/build-binaries.sh`).
 * For development (Bun), reads from package.json and retrieves git commit at runtime.
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileAsync } from '@archon/git';
import {
  BUNDLED_GIT_COMMIT,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  createLogger,
} from '@archon/paths';
import { getDatabaseType } from '@archon/core';

const log = createLogger('cli:version');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  name: string;
  version: string;
}

/**
 * Get version for development mode (reads package.json)
 */
async function getDevVersion(): Promise<{ name: string; version: string }> {
  // Read root package.json (monorepo version), not the CLI package's own
  const pkgPath = join(SCRIPT_DIR, '../../../../package.json');

  let content: string;
  try {
    content = await readFile(pkgPath, 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error('Failed to read version: package.json not found (bad installation?)');
    } else if (err.code === 'EACCES') {
      throw new Error('Failed to read version: permission denied reading package.json');
    }
    throw new Error(`Failed to read version: ${err.message}`);
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(content) as PackageJson;
  } catch (_error) {
    throw new Error('Failed to read version: package.json is malformed');
  }

  return { name: pkg.name, version: pkg.version };
}

/**
 * Get the git commit hash at runtime (dev mode).
 * Returns 'unknown' if git is unavailable or the command fails.
 */
async function getDevGitCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      timeout: 5000,
    });
    return stdout.trim();
  } catch (err) {
    // Non-blocking: git may not be installed or cwd may not be a git repo
    log.debug({ err }, 'version.git_commit_lookup_failed');
    return 'unknown';
  }
}

export async function versionCommand(): Promise<void> {
  let version: string;
  let gitCommit: string;

  if (BUNDLED_IS_BINARY) {
    // Compiled binary: use embedded version and commit
    version = BUNDLED_VERSION;
    gitCommit = BUNDLED_GIT_COMMIT;
  } else {
    // Development mode: read from package.json and git
    const devInfo = await getDevVersion();
    version = devInfo.version;
    gitCommit = await getDevGitCommit();
  }

  const platform = process.platform;
  const arch = process.arch;
  const dbType = getDatabaseType();
  const buildType = BUNDLED_IS_BINARY ? 'binary' : 'source (bun)';

  console.log(`Archon CLI v${version}`);
  console.log(`  Platform: ${platform}-${arch}`);
  console.log(`  Build: ${buildType}`);
  console.log(`  Database: ${dbType}`);
  console.log(`  Git commit: ${gitCommit}`);
}
