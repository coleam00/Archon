/**
 * Version command - displays version info
 *
 * For compiled binaries, the version is embedded via `@archon/paths` build-time constants
 * (rewritten by `scripts/build-binaries.sh`); from source it is read from package.json.
 * The commit comes from `readArchonCommit`, which names Archon's own commit, never the
 * caller's working directory; the line is omitted when no commit is known.
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readArchonCommit } from '@archon/git/archon-commit';
import { BUNDLED_IS_BINARY, BUNDLED_VERSION } from '@archon/paths';
import { getDatabaseType } from '@archon/core';

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

/** The running Archon version: embedded in a binary, read from package.json from source. */
export async function getArchonVersion(): Promise<string> {
  return BUNDLED_IS_BINARY ? BUNDLED_VERSION : (await getDevVersion()).version;
}

export async function versionCommand(): Promise<void> {
  const version = await getArchonVersion();
  const commit = await readArchonCommit();

  const platform = process.platform;
  const arch = process.arch;
  const dbType = getDatabaseType();
  const buildType = BUNDLED_IS_BINARY ? 'binary' : 'source (bun)';

  console.log(`Archon CLI v${version}`);
  console.log(`  Platform: ${platform}-${arch}`);
  console.log(`  Build: ${buildType}`);
  console.log(`  Database: ${dbType}`);
  if (commit) console.log(`  Git commit: ${commit.sha}`);
}
