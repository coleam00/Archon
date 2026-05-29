/**
 * Update-check command — explicit check for a newer Archon release.
 *
 * Standalone (no server required): calls the same `checkForUpdate` helper the
 * CLI uses for its startup notice, which queries the GitHub Releases API (with
 * a short timeout and local cache). Meaningful for binary installs; source
 * builds report against the bundled version.
 */
import { checkForUpdate, BUNDLED_VERSION } from '@archon/paths';

export async function updateCheckCommand(json?: boolean): Promise<void> {
  const result = await checkForUpdate(BUNDLED_VERSION);

  if (result === null) {
    // Network error or unparseable response — checkForUpdate swallows and returns null.
    if (json) {
      console.log(
        JSON.stringify({ updateAvailable: false, currentVersion: BUNDLED_VERSION }, null, 2)
      );
    } else {
      console.error('Could not check for updates (network error or GitHub unavailable).');
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.updateAvailable) {
    console.log(`Update available: v${result.currentVersion} -> v${result.latestVersion}`);
    if (result.releaseUrl) console.log(`Release: ${result.releaseUrl}`);
  } else {
    console.log(`Up to date (v${result.currentVersion}).`);
  }
}
