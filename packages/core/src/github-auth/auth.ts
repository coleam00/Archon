/**
 * GitHub App auth provider factory.
 *
 * Two-level cache:
 *   1. lookupCache: `owner/repo → installationId` (1h TTL; refreshed on 401)
 *   2. tokenCache:  `installationId → CachedInstallationToken` (1h GitHub TTL,
 *      we refresh 5min before expiry on access)
 *
 * No background timers — refresh-on-access only. The cache lookup itself
 * decides whether to issue a new token; no setInterval, no leaked handles,
 * survives process suspend/resume cleanly.
 *
 * 401 handling: `invalidateToken(installationId)` evicts the cached token.
 * The adapter wraps its Octokit calls in a single-retry helper that calls
 * this, refreshes, and retries — so the auth module stays purely cache-aware
 * rather than retry-aware.
 */
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createLogger } from '@archon/paths';
import type { GitHubAppConfig, IGitHubAppAuthProvider, CachedInstallationToken } from './types';
import { AppNotInstalledError } from './errors';

/** Refresh the cached token if it will expire within this window (ms). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** owner/repo → installationId TTL. App install/uninstall is rare; 1h is plenty. */
const LOOKUP_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('github-auth');
  return cachedLog;
}

interface RepoLookup {
  installationId: number;
  cachedAt: number;
}

function lookupKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export function createGitHubAppAuthProvider(config: GitHubAppConfig): IGitHubAppAuthProvider {
  // App-level Octokit (uses JWT). Used for `/repos/{owner}/{repo}/installation`
  // lookups and for issuing installation access tokens.
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey: config.privateKey },
  });

  const tokenCache = new Map<number, CachedInstallationToken>();
  const lookupCache = new Map<string, RepoLookup>();
  const octokitCache = new Map<number, Octokit>();

  async function resolveInstallationId(owner: string, repo: string): Promise<number> {
    if (config.defaultInstallationId) return config.defaultInstallationId;
    const key = lookupKey(owner, repo);
    const cached = lookupCache.get(key);
    if (cached && Date.now() - cached.cachedAt < LOOKUP_CACHE_TTL_MS) {
      return cached.installationId;
    }
    getLog().debug({ owner, repo }, 'github_auth.install_lookup_started');
    try {
      const res = await appOctokit.request('GET /repos/{owner}/{repo}/installation', {
        owner,
        repo,
      });
      const installationId = res.data.id;
      lookupCache.set(key, { installationId, cachedAt: Date.now() });
      getLog().info({ owner, repo, installationId }, 'github_auth.install_lookup_completed');
      return installationId;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        getLog().warn({ owner, repo }, 'github_auth.install_lookup_not_installed');
        throw new AppNotInstalledError(owner, repo, config.slug);
      }
      getLog().error({ err, owner, repo }, 'github_auth.install_lookup_failed');
      throw err;
    }
  }

  async function getInstallationTokenById(installationId: number): Promise<string> {
    const cached = tokenCache.get(installationId);
    if (cached && Date.now() + REFRESH_BUFFER_MS < cached.expiresAt) {
      return cached.token;
    }
    getLog().debug({ installationId }, 'github_auth.token_resolve_started');
    const res = await appOctokit.request(
      'POST /app/installations/{installation_id}/access_tokens',
      { installation_id: installationId }
    );
    const token = res.data.token;
    const expiresAt = new Date(res.data.expires_at).getTime();
    tokenCache.set(installationId, { token, expiresAt });
    getLog().info({ installationId, expiresAt }, 'github_auth.token_resolve_completed');
    return token;
  }

  async function getInstallationToken(owner: string, repo: string): Promise<string> {
    const installationId = await resolveInstallationId(owner, repo);
    return getInstallationTokenById(installationId);
  }

  async function getOctokitForInstallation(owner: string, repo: string): Promise<Octokit> {
    const installationId = await resolveInstallationId(owner, repo);
    let octokit = octokitCache.get(installationId);
    if (!octokit) {
      // Each per-installation Octokit drives `createAppAuth` internally so its
      // requests carry installation-scoped tokens and auto-refresh on expiry
      // within the SDK. We still cache tokens explicitly above for the clone
      // path + credential-helper endpoint, which need the raw token string.
      octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: config.appId,
          privateKey: config.privateKey,
          installationId,
        },
      });
      octokitCache.set(installationId, octokit);
    }
    return octokit;
  }

  function primeInstallationLookup(owner: string, repo: string, installationId: number): void {
    if (config.defaultInstallationId) return; // priming is a no-op when fixed-install
    lookupCache.set(lookupKey(owner, repo), { installationId, cachedAt: Date.now() });
    getLog().debug({ owner, repo, installationId }, 'github_auth.install_lookup_primed');
  }

  function invalidateToken(installationId: number): void {
    tokenCache.delete(installationId);
    getLog().info({ installationId }, 'github_auth.token_cache_evicted_on_401');
  }

  return {
    slug: config.slug,
    getInstallationToken,
    getInstallationTokenById,
    getOctokitForInstallation,
    resolveInstallationId,
    primeInstallationLookup,
    invalidateToken,
  };
}
