import { resolve } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';
import { ghShimScript } from './gh-shim-script';
import { installManagedScript } from './managed-script';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('github-auth.gh-shim');
  return cachedLog;
}

/**
 * Install the `gh` shim (see gh-archon.sh) and return its directory. The
 * directory holds only `gh`, so a run that puts it first on PATH shadows
 * nothing else. Throws when the script cannot be written.
 */
export function installGitHubCliShim(): string {
  const shimDir = resolve(getArchonHome(), 'bin', 'gh-shim');
  const shimPath = resolve(shimDir, 'gh');
  if (installManagedScript(shimPath, ghShimScript)) {
    getLog().info({ shimPath }, 'github_auth.gh_shim_updated');
  }
  return shimDir;
}
