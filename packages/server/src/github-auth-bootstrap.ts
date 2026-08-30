/**
 * Pure helpers consumed by the server bootstrap path for GitHub adapter
 * configuration. Extracted from index.ts so the security-critical decisions
 * (OAuth App env detection, /internal/git-credential path parsing) are
 * testable in isolation without spinning up the full Hono stack.
 */

/**
 * Result of detecting which GitHub auth mode the operator configured.
 * Discriminated on `kind` so callers narrow exhaustively at compile time.
 *
 * `'oauth'` — plain OAuth App: GITHUB_CLIENT_ID + TOKEN_ENCRYPTION_KEY +
 *             WEBHOOK_SECRET are set. Every GitHub operation requires a
 *             per-user token from the vault; there is no bot/PAT fallback.
 * `'none'`  — GitHub adapter not configured.
 */
export type GitHubAuthModeDecision = { kind: 'oauth' } | { kind: 'none' };

/**
 * Decide GitHub auth mode from env. One mode: OAuth App (user credentials
 * only). No PAT mode, no GitHub App mode. Every GitHub operation requires
 * a per-user token from the vault.
 */
export function selectGitHubAuthMode(env: NodeJS.ProcessEnv): GitHubAuthModeDecision {
  const hasOAuth = Boolean(env.GITHUB_CLIENT_ID && env.TOKEN_ENCRYPTION_KEY && env.WEBHOOK_SECRET);
  if (hasOAuth) return { kind: 'oauth' };
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
