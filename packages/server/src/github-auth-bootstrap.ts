/**
 * Pure helpers consumed by the server bootstrap path for GitHub adapter
 * configuration. Extracted from index.ts so the security-critical decisions
 * (dual-mode env detection, /internal/git-credential path parsing) are
 * testable in isolation without spinning up the full Hono stack.
 */

import { parseOwnerRepo } from '@archon/paths/archon-paths';

/**
 * Result of detecting which GitHub auth mode the operator configured.
 * Discriminated on `kind` so callers narrow exhaustively at compile time.
 */
export type GitHubAuthModeDecision =
  | { kind: 'app' }
  | { kind: 'pat' }
  | { kind: 'none' }
  | { kind: 'conflict'; message: string };

/**
 * Decide GitHub auth mode from env, refusing both modes set simultaneously.
 *
 * "Refuse" is intentional — silently preferring one over the other creates
 * 3am incidents for operators who copy-pasted half a config and didn't
 * realise the other half was already set in /etc/archon/.env.
 */
export function selectGitHubAuthMode(env: NodeJS.ProcessEnv): GitHubAuthModeDecision {
  const hasGitHubApp = Boolean(
    env.GITHUB_APP_ID &&
    (env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH) &&
    env.WEBHOOK_SECRET
  );
  const hasGitHubPat = Boolean(env.GITHUB_TOKEN && env.WEBHOOK_SECRET);

  if (hasGitHubApp && hasGitHubPat) {
    return {
      kind: 'conflict',
      message:
        'GitHub adapter misconfigured: both App mode (GITHUB_APP_ID) and PAT mode ' +
        '(GITHUB_TOKEN) are configured. Pick one — unset GITHUB_TOKEN for App mode, ' +
        'or unset GITHUB_APP_ID for PAT mode.',
    };
  }
  if (hasGitHubApp) return { kind: 'app' };
  if (hasGitHubPat) return { kind: 'pat' };
  return { kind: 'none' };
}

/** Parse the Git credential path using the same identity rules as URL registration. */
export function parseGitCredentialPath(pathStr: string): { owner: string; repo: string } | null {
  return parseOwnerRepo(pathStr.endsWith('.git') ? pathStr.slice(0, -4) : pathStr);
}
