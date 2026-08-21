/**
 * Parse a project repo's git remote URL into a GitHub owner/repo, and probe
 * whether the resolved GitHub credential can write to it.
 *
 * Stored/observed remote URLs may embed a clone-time token as URL userinfo
 * (`https://<token>@github.com/o/r.git` — see `cloneRepository`,
 * `@archon/git/repo.ts:311-331`). Reading `hostname`/`pathname` off a parsed
 * `URL` never surfaces `username`/`password`, so the parse below can't leak a
 * token by construction — never read `.username`/`.password` off the parsed URL.
 */
import type { Octokit } from '@octokit/rest';

/** Why a repo can't be written to. `no-origin` covers unparseable/non-GitHub remotes. */
export type GitHubOriginBlockReason = 'no-origin' | 'private' | 'archived' | 'no-push-permission';

export interface GitHubOrigin {
  owner: string;
  repo: string;
}

function stripDotGit(repo: string): string {
  return repo.replace(/\.git$/i, '');
}

/**
 * Parse `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`, and
 * token-embedded `https://<token>@github.com/o/r` remote URLs. Returns null
 * for non-GitHub hosts or unparseable URLs — callers map that to the
 * `no-origin` block reason.
 */
export function parseGitHubOrigin(remoteUrl: string): GitHubOrigin | null {
  const trimmed = remoteUrl.trim();
  if (trimmed === '') return null;

  const sshMatch = /^git@github\.com:([^/]+)\/(.+)$/i.exec(trimmed);
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    if (!owner || !repo) return null;
    return { owner, repo: stripDotGit(repo) };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.hostname.toLowerCase() !== 'github.com') return null;

  const segments = stripDotGit(parsed.pathname).split('/').filter(Boolean);
  if (segments.length !== 2) return null;
  const [owner, repo] = segments;
  if (!owner || !repo) return null;
  return { owner, repo };
}

export interface RepoCapability {
  defaultBranch: string;
}

/**
 * `repos.get` on the project origin — converts GitHub-App-installation-coverage
 * uncertainty into a deterministic pre-write gate. Blocks on private, archived,
 * or `permissions.push !== true`.
 */
export async function probeRepoCapability(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<
  { ok: true; capability: RepoCapability } | { ok: false; reason: GitHubOriginBlockReason }
> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  if (data.private) return { ok: false, reason: 'private' };
  if (data.archived) return { ok: false, reason: 'archived' };
  if (data.permissions?.push !== true) return { ok: false, reason: 'no-push-permission' };
  return { ok: true, capability: { defaultBranch: data.default_branch } };
}
