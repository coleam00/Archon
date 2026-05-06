/**
 * GitHub host configuration helpers.
 *
 * Reads `GITHUB_HOST` and `GITHUB_API_URL` from the environment with sensible
 * defaults so callers don't sprinkle `process.env.*` reads across the codebase.
 *
 * - `GITHUB_HOST` is the user-facing hostname used for clone URLs and the git
 *   credential helper (e.g. `github.com`, `ghe.example.com`). Lowercased and
 *   stripped of any leading scheme/trailing slash.
 * - `GITHUB_API_URL` is the REST API base URL passed to Octokit (e.g.
 *   `https://api.github.com`, `https://ghe.example.com/api/v3`). Trailing
 *   slashes are stripped; left undefined when unset so Octokit applies its own
 *   default.
 */

const DEFAULT_GITHUB_HOST = 'github.com';

/**
 * Return the configured GitHub host, defaulting to `github.com`.
 * The result is lowercase and contains no scheme or trailing slash.
 */
export function getGitHubHost(): string {
  const raw = process.env.GITHUB_HOST?.trim();
  if (!raw) return DEFAULT_GITHUB_HOST;
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Return the configured GitHub REST API URL, or `undefined` when the user
 * hasn't set `GITHUB_API_URL`. Returning `undefined` (rather than
 * `https://api.github.com`) lets Octokit fall back to its own default and
 * keeps the public github.com behavior identical to versions that predate
 * this option.
 */
export function getGitHubApiUrl(): string | undefined {
  const raw = process.env.GITHUB_API_URL?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, '');
}

/**
 * Convenience: true when the configured host is the public github.com.
 * Useful for code paths that only need to know whether they're in
 * Enterprise mode (e.g. to skip features that don't make sense off-public).
 */
export function isPublicGitHub(): boolean {
  return getGitHubHost() === DEFAULT_GITHUB_HOST;
}
