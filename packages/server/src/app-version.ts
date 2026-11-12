import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileAsync } from '@archon/git';
import { BUNDLED_GIT_COMMIT, BUNDLED_IS_BINARY, BUNDLED_VERSION } from '@archon/paths';
import type { AppCommit } from './routes/schemas/system.schemas';
import { getLog } from './server-log';

const SOURCE_ROOT = join(import.meta.dir, '../../..');

/** The running server's version: the build-time constant in a binary, package.json in source. */
export const appVersion = readAppVersion();

function readAppVersion(): string {
  if (BUNDLED_IS_BINARY) return BUNDLED_VERSION;
  const path = join(SOURCE_ROOT, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch (err) {
    getLog().debug({ err, path }, 'app_version.read_failed');
    return 'unknown';
  }
}

/**
 * The commit the running server came from: the build-time hash in a binary, the source
 * checkout's HEAD in source. Call it once at boot, never per request: the checkout can move
 * after the server loaded its code, and a later read would name code that is not running.
 * Undefined when there is no commit to name, such as a source tree without git metadata.
 */
export async function readAppCommit(sourceRoot = SOURCE_ROOT): Promise<AppCommit | undefined> {
  if (BUNDLED_IS_BINARY) {
    return BUNDLED_GIT_COMMIT === 'unknown'
      ? undefined
      : { sha: BUNDLED_GIT_COMMIT, committedAt: null };
  }
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%h%n%cI'], {
      cwd: sourceRoot,
      timeout: 5000,
    });
    const [sha, committedAt] = stdout.trim().split('\n');
    if (!sha || !committedAt) throw new Error(`unexpected git log output: ${stdout}`);
    return { sha, committedAt };
  } catch (err) {
    getLog().debug({ err, sourceRoot }, 'app_commit.read_failed');
    return undefined;
  }
}
