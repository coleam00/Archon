import { getRemoteUrl } from './repo';
import type { RepoPath } from './types';

/** Supported forge platforms */
export type ForgeType = 'github' | 'gitea' | 'gitlab' | 'unknown';

/** Result of forge detection — type + API base URL */
export interface ForgeInfo {
  type: ForgeType;
  apiBase: string;
}

/**
 * Extract hostname from a git remote URL.
 * Handles both HTTPS (https://github.com/owner/repo.git) and
 * SSH (git@github.com:owner/repo.git) formats.
 */
function extractHostname(remoteUrl: string): string | null {
  // HTTPS: https://github.com/owner/repo.git
  try {
    const url = new URL(remoteUrl);
    return url.hostname.toLowerCase();
  } catch {
    // Not a valid URL — try SSH format
  }

  // SSH: git@github.com:owner/repo.git
  const sshRegex = /^[^@]+@([^:]+):/;
  const sshMatch = sshRegex.exec(remoteUrl);
  if (sshMatch) {
    return sshMatch[1].toLowerCase();
  }

  return null;
}

/**
 * Safely extract hostname from an env-var URL (e.g. GITEA_URL).
 * Returns null if the env var is unset or not a valid URL.
 */
function hostnameFromEnv(envVar: string): string | null {
  const value = process.env[envVar];
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Detect the forge platform from the git remote origin URL.
 *
 * Detection order:
 * 1. github.com hostname → GitHub
 * 2. GITHUB_URL env hostname match → GitHub Enterprise
 * 3. GITEA_URL env hostname match → Gitea
 * 4. gitlab.com hostname → GitLab
 * 5. GITLAB_URL env hostname match → GitLab (self-hosted)
 * 6. No match → unknown
 *
 * Returns { type: 'github', apiBase: 'https://api.github.com' } as the
 * backwards-compatible default when no remote exists.
 */
export async function detectForge(repoPath: RepoPath): Promise<ForgeInfo> {
  const remoteUrl = await getRemoteUrl(repoPath);

  if (!remoteUrl) {
    // No remote — default to github for backwards compatibility
    return { type: 'github', apiBase: 'https://api.github.com' };
  }

  const hostname = extractHostname(remoteUrl);
  if (!hostname) {
    return { type: 'unknown', apiBase: '' };
  }

  // 1. GitHub (public)
  if (hostname === 'github.com') {
    return { type: 'github', apiBase: 'https://api.github.com' };
  }

  // 2. GitHub Enterprise — match against GITHUB_URL env
  const githubUrl = process.env.GITHUB_URL;
  const githubHostname = hostnameFromEnv('GITHUB_URL');
  if (githubUrl && githubHostname && hostname === githubHostname) {
    const cleanUrl = githubUrl.replace(/\/+$/, '');
    return { type: 'github', apiBase: `${cleanUrl}/api/v3` };
  }

  // 3. Gitea — match against GITEA_URL env
  const giteaUrl = process.env.GITEA_URL;
  const giteaHostname = hostnameFromEnv('GITEA_URL');
  if (giteaUrl && giteaHostname && hostname === giteaHostname) {
    const cleanUrl = giteaUrl.replace(/\/+$/, '');
    return { type: 'gitea', apiBase: `${cleanUrl}/api/v1` };
  }

  // 3. GitLab (public)
  if (hostname === 'gitlab.com') {
    return { type: 'gitlab', apiBase: 'https://gitlab.com/api/v4' };
  }

  // 4. GitLab (self-hosted) — match against GITLAB_URL env
  const gitlabUrl = process.env.GITLAB_URL;
  const gitlabHostname = hostnameFromEnv('GITLAB_URL');
  if (gitlabUrl && gitlabHostname && hostname === gitlabHostname) {
    const cleanUrl = gitlabUrl.replace(/\/+$/, '');
    return { type: 'gitlab', apiBase: `${cleanUrl}/api/v4` };
  }

  return { type: 'unknown', apiBase: '' };
}
