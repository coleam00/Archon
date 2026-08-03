/**
 * GitHub App auth provider factory.
 *
 * Three caches — two visible, one hidden inside `@octokit/auth-app`:
 *   1. lookupCache:  `owner/repo → installationId` (1h TTL; evicted on 401 via
 *      invalidateRepo so an App reinstall — which assigns a NEW installation
 *      id — doesn't lock us into the stale id for the full hour).
 *   2. tokenCache:   `installationId → CachedInstallationToken` (1h GitHub TTL,
 *      we refresh 5min before expiry on access). Used directly for clone-path
 *      URL embedding and the /internal/git-credential endpoint.
 *   3. octokitCache: `installationId → Octokit` (memoisation, no TTL). Each
 *      Octokit holds its OWN private `createAppAuth` token state, opaque to
 *      us. THIS is the load-bearing reason invalidateToken / invalidateRepo
 *      must `octokitCache.delete(id)` — without it the "fresh" Octokit handed
 *      to the retry path keeps serving the dead token from the SDK's hidden
 *      cache, and our visible cache evictions are pointless. (See PR #1788
 *      CodeRabbit comment "401 recovery doesn't invalidate the cached
 *      installation Octokit.")
 *
 * No background timers — refresh-on-access only. The cache lookup itself
 * decides whether to issue a new token; no setInterval, no leaked handles,
 * survives process suspend/resume cleanly.
 *
 * 401 handling: `invalidateRepo(owner, repo)` evicts ALL THREE caches for
 * that repo. The adapter wraps its Octokit calls in a single-retry helper
 * that calls this and re-resolves, so the auth module stays purely
 * cache-aware rather than retry-aware.
 */
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createLogger } from '@archon/paths';
import type { GitHubAppConfig, IGitHubAppAuthProvider, CachedInstallationToken } from './types';
import { AppNotInstalledError, AppPrivateKeyError } from './errors';

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
  // Validate config at the boundary so misconfiguration surfaces at server
  // bootstrap, not at the first webhook. loadAppPrivateKey already enforces
  // the same "fail at start" contract for the PEM.
  if (!config.appId.trim()) {
    throw new AppPrivateKeyError(
      'createGitHubAppAuthProvider: appId is empty. Set GITHUB_APP_ID to the numeric App ID.'
    );
  }
  if (!config.slug.trim()) {
    throw new AppPrivateKeyError(
      'createGitHubAppAuthProvider: slug is empty. Set GITHUB_APP_SLUG to the App slug.'
    );
  }

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
    if (cached && Date.now() + REFRESH_BUFFER_MS < cached.expiresAtMs) {
      return cached.token;
    }
    getLog().debug({ installationId }, 'github_auth.token_resolve_started');
    try {
      const res = await appOctokit.request(
        'POST /app/installations/{installation_id}/access_tokens',
        { installation_id: installationId }
      );
      const token = res.data.token;
      const expiresAtMs = new Date(res.data.expires_at).getTime();
      tokenCache.set(installationId, { token, expiresAtMs });
      getLog().info({ installationId, expiresAtMs }, 'github_auth.token_resolve_completed');
      return token;
    } catch (err) {
      // Surface the installationId in logs — without this the upstream
      // handler only sees "401 from Octokit" with no link back to which
      // installation died.
      getLog().error(
        { err, installationId, status: (err as { status?: number }).status },
        'github_auth.token_resolve_failed'
      );
      throw err;
    }
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
    // Also drop the cached per-installation Octokit. createAppAuth maintains
    // its OWN internal token state inside each Octokit; if we kept the same
    // Octokit instance after a 401 it could keep serving the dead token from
    // its private cache even though our tokenCache is empty. Forcing a
    // fresh Octokit on the next call rebuilds the auth strategy from
    // scratch and lets it issue a new installation access token.
    octokitCache.delete(installationId);
    // Cascade: drop any owner/repo lookups pointing at this dead id so the
    // next call re-resolves via GET /repos/.../installation instead of
    // serving the stale id from cache. Matters when an App is uninstalled +
    // reinstalled — the reinstall gets a NEW id, but the old lookupCache
    // entry would map to the old (now-dead) id until 1h TTL expiry.
    for (const [key, entry] of lookupCache) {
      if (entry.installationId === installationId) {
        lookupCache.delete(key);
      }
    }
    getLog().info({ installationId }, 'github_auth.token_cache_evicted_on_401');
  }

  function invalidateRepo(owner: string, repo: string): void {
    const key = lookupKey(owner, repo);
    const lookup = lookupCache.get(key);
    if (lookup) {
      tokenCache.delete(lookup.installationId);
      octokitCache.delete(lookup.installationId);
      lookupCache.delete(key);
      getLog().info(
        { owner, repo, installationId: lookup.installationId },
        'github_auth.repo_cache_evicted_on_401'
      );
      return;
    }
    // No cached lookup (default-installation-id mode, or the cache TTL'd
    // since the call that 401'd). Still evict the default-install token +
    // Octokit when applicable so the next call re-issues.
    if (config.defaultInstallationId) {
      tokenCache.delete(config.defaultInstallationId);
      octokitCache.delete(config.defaultInstallationId);
      getLog().info(
        { owner, repo, installationId: config.defaultInstallationId },
        'github_auth.default_install_token_evicted_on_401'
      );
    }
  }

  return {
    slug: config.slug,
    getInstallationToken,
    getInstallationTokenById,
    getOctokitForInstallation,
    resolveInstallationId,
    primeInstallationLookup,
    invalidateToken,
    invalidateRepo,
  };
}
