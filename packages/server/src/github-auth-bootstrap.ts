/**
 * GitHub bootstrap helpers, testable without starting the server.
 */

import { parseOwnerRepo } from '@archon/paths/archon-paths';

/** Parse the Git credential path using the same identity rules as URL registration. */
export function parseGitCredentialPath(pathStr: string): { owner: string; repo: string } | null {
  return parseOwnerRepo(pathStr.endsWith('.git') ? pathStr.slice(0, -4) : pathStr);
}
