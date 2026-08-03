/**
 * Pure helpers consumed by the server bootstrap path for GitHub adapter
 * configuration. Extracted from index.ts so the security-critical decisions
 * (dual-mode env detection, /internal/git-credential path parsing) are
 * testable in isolation without spinning up the full Hono stack.
 */

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

/**
 * Parse a credential-helper `path` field into (owner, repo). Used by the
 * /internal/git-credential endpoint to resolve which installation to issue
 * a token for. Returns null on anything that doesn't look like
 * `owner/repo` or `owner/repo.git`.
 *
 * Defence-in-depth: the credential helper script does its own client-side
 * validation, but this regex is the actual gate that decides which repo's
 * token leaves the server. Tested exhaustively in github-auth-bootstrap.test.ts.
 */
export function parseGitCredentialPath(pathStr: string): { owner: string; repo: string } | null {
  // Strict: exactly two segments, each non-empty. Reject leading dot
  // (hidden segments) and inner slashes (would let a crafted path resolve
  // to a different repo than the operator intended).
  const match = /^([^/.][^/]*)\/([^/.][^/]*?)(?:\.git)?$/.exec(pathStr);
  if (!match) return null;
  const [, owner, repo] = match;
  // Belt-and-braces:
  //  - reject `..` segments after match (the regex blocks leading `.` but
  //    not `foo..bar`)
  //  - reject null bytes (eslint forbids `\x00` in the regex literal, so we
  //    check the captured groups instead — same outcome at runtime)
  if (owner.includes('..') || repo.includes('..') || owner.includes('\0') || repo.includes('\0')) {
    return null;
  }
  return { owner, repo };
}
