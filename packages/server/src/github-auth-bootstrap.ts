/**
 * GitHub bootstrap helpers, testable without starting the server.
 */

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
  //  - reject null bytes in the captured groups
  if (owner.includes('..') || repo.includes('..') || owner.includes('\0') || repo.includes('\0')) {
    return null;
  }
  return { owner, repo };
}
