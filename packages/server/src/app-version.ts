import { readFileSync } from 'fs';
import { join } from 'path';
import { BUNDLED_IS_BINARY, BUNDLED_VERSION } from '@archon/paths';
import { getLog } from './server-log';

/** The running server's version: the build-time constant in a binary, package.json in source. */
export const appVersion = readAppVersion();

function readAppVersion(): string {
  if (BUNDLED_IS_BINARY) return BUNDLED_VERSION;
  const path = join(import.meta.dir, '../../../package.json');
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch (err) {
    getLog().debug({ err, path }, 'app_version.read_failed');
    return 'unknown';
  }
}
