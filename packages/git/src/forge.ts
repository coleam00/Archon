// Forge detection: identify the hosting platform (GitHub, Gitea, GitLab)
// behind a repository's remote (default `origin`), plus its REST API base URL.

import { getRemoteUrl } from './repo';
import type { RepoPath } from './types';

/** Forge platform detected from a repository's remote */
export type ForgeType = 'github' | 'gitea' | 'gitlab' | 'unknown';

/** Result of forge detection: platform type + REST API base URL */
export interface ForgeInfo {
  type: ForgeType;
  /** REST API base URL for the forge; empty string when the forge is unknown */
  apiBase: string;
}

/**
 * Extract the hostname from a git remote URL.
 * Handles HTTPS (`https://github.com/owner/repo.git`) and
 * SSH (`git@github.com:owner/repo.git`) formats.
 */
function extractHostname(remoteUrl: string): string | null {
  try {
    return new URL(remoteUrl).hostname.toLowerCase();
  } catch {
    // Not a standard URL — fall through to SSH scp-like syntax
  }
  const sshMatch = /^[^@]+@([^:]+):/.exec(remoteUrl);
  const host = sshMatch?.[1];
  return host ? host.toLowerCase() : null;
}

/**
 * Match a remote hostname against a self-hosted forge base URL taken from an
 * env var (e.g. `GITEA_URL`). Returns the base URL with trailing slashes
 * stripped when the hostnames match; null when the env var is unset, not a
 * valid URL, or points at a different host. An invalid env value is ignored
 * rather than misdetecting — the caller falls through to the next rule.
 */
function matchSelfHostedForge(envVar: string, hostname: string): string | null {
  const value = process.env[envVar];
  if (!value) return null;
  let envHostname: string;
  try {
    envHostname = new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (envHostname !== hostname) return null;
  return value.replace(/\/+$/, '');
}

/**
 * Detect the forge platform behind a repository's remote (default: `origin`).
 *
 * Detection order:
 * 1. `github.com` hostname → GitHub (`https://api.github.com`)
 * 2. `GITHUB_URL` env hostname match → GitHub Enterprise (`<base>/api/v3`)
 * 3. `GITEA_URL` env hostname match → Gitea (`<base>/api/v1`)
 * 4. `gitlab.com` hostname → GitLab (`https://gitlab.com/api/v4`)
 * 5. `GITLAB_URL` env hostname match → self-hosted GitLab (`<base>/api/v4`)
 * 6. No match → `unknown` (empty apiBase)
 *
 * A repository without the requested remote defaults to GitHub for backwards
 * compatibility with existing GitHub-only callers.
 *
 * @param repoPath - Path to the git repository
 * @param remote - Remote name to inspect (default: 'origin')
 */
export async function detectForge(repoPath: RepoPath, remote = 'origin'): Promise<ForgeInfo> {
  const remoteUrl = await getRemoteUrl(repoPath, remote);
  if (!remoteUrl) {
    return { type: 'github', apiBase: 'https://api.github.com' };
  }

  const hostname = extractHostname(remoteUrl);
  if (!hostname) {
    return { type: 'unknown', apiBase: '' };
  }

  if (hostname === 'github.com') {
    return { type: 'github', apiBase: 'https://api.github.com' };
  }

  const githubEnterpriseBase = matchSelfHostedForge('GITHUB_URL', hostname);
  if (githubEnterpriseBase) {
    return { type: 'github', apiBase: `${githubEnterpriseBase}/api/v3` };
  }

  const giteaBase = matchSelfHostedForge('GITEA_URL', hostname);
  if (giteaBase) {
    return { type: 'gitea', apiBase: `${giteaBase}/api/v1` };
  }

  if (hostname === 'gitlab.com') {
    return { type: 'gitlab', apiBase: 'https://gitlab.com/api/v4' };
  }

  const gitlabBase = matchSelfHostedForge('GITLAB_URL', hostname);
  if (gitlabBase) {
    return { type: 'gitlab', apiBase: `${gitlabBase}/api/v4` };
  }

  return { type: 'unknown', apiBase: '' };
}
