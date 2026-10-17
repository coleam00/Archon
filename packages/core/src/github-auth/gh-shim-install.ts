import { dirname, resolve } from 'node:path';
import { createLogger } from '@archon/paths';
import { installCredentialHelperScript } from './credential-helper-install';
import { ghShimScript } from './gh-shim-script';
import { installManagedScript } from './managed-script';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('github-auth.gh-shim');
  return cachedLog;
}

/**
 * Install the `gh` shim (see gh-archon.sh) and return its directory. The shim
 * gets its token from git-credential-archon in its parent directory, so the
 * helper is installed alongside. The directory holds only `gh`, so a run that
 * puts it first on PATH shadows nothing else. Throws when a script cannot be
 * written.
 */
export function installGitHubCliShim(): string {
  const shimDir = resolve(dirname(installCredentialHelperScript()), 'gh-shim');
  const shimPath = resolve(shimDir, 'gh');
  if (installManagedScript(shimPath, ghShimScript)) {
    getLog().info({ shimPath }, 'github_auth.gh_shim_updated');
  }
  return shimDir;
}
