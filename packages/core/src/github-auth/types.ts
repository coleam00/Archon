/**
 * Public type surface for the GitHub App auth module.
 *
 * The adapter consumes IGitHubAppAuthProvider; everything else here is internal
 * to packages/core/src/github-auth/.
 */
import type { Octokit } from '@octokit/rest';

/**
 * Configuration for the GitHub App auth provider, sourced from env at server
 * bootstrap. `privateKey` is the PEM contents (not a filesystem path) — the
 * resolution from env (inline PEM vs. file path) happens in `private-key.ts`
 * before this config reaches the factory.
 */
export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  /**
   * Optional: skip the per-(owner, repo) installation lookup when set. Useful
   * for single-installation deployments to avoid one HTTP round trip per repo
   * on first sight after a restart.
   */
  defaultInstallationId?: number;
  /** App slug (e.g. "archon"); used to derive the bot login `<slug>[bot]` for self-filter. */
  slug: string;
}

/** A cached installation token with its absolute expiry timestamp (ms epoch). */
export interface CachedInstallationToken {
  token: string;
  /** Absolute expiry timestamp in milliseconds since epoch (suffix indicates unit). */
  expiresAtMs: number;
}

/**
 * Public provider surface consumed by GitHubAdapter, the workflow subprocess
 * env injection, and the credential-helper endpoint.
 */
export interface IGitHubAppAuthProvider {
  /** The app slug (e.g. "archon"); enables `<slug>[bot]` self-filter in App mode. */
  readonly slug: string;

  /**
   * Resolve a fresh installation token for the (owner, repo). Uses a two-level
   * cache: lookupCache for `owner/repo → installationId`, tokenCache for
   * `installationId → token`. Refreshes ahead of expiry (5min buffer).
   */
  getInstallationToken(owner: string, repo: string): Promise<string>;

  /** Same as above but takes a pre-resolved installationId (skips lookup). */
  getInstallationTokenById(installationId: number): Promise<string>;

  /**
   * Return an Octokit instance authenticated for the given (owner, repo). Each
   * call may return a different installation's Octokit when the team operates
   * across multiple installations.
   */
  getOctokitForInstallation(owner: string, repo: string): Promise<Octokit>;

  /**
   * Prime the lookup cache from a webhook payload (which carries
   * `installation.id`) — saves one HTTP round trip on inbound events.
   */
  primeInstallationLookup(owner: string, repo: string, installationId: number): void;

  /**
   * Resolve the installationId for (owner, repo). Exposed so adapters can call
   * `invalidateToken` with the right id after a 401, without an extra Octokit
   * call to derive it.
   */
  resolveInstallationId(owner: string, repo: string): Promise<number>;

  /** Force-evict a cached token (called on 401 to trigger a refresh). */
  invalidateToken(installationId: number): void;

  /**
   * Force-evict the cached install + token for (owner, repo). Used on 401
   * from a per-installation Octokit so the next call re-resolves the
   * installation id (App uninstall + reinstall assigns a NEW id; the stale
   * lookupCache entry would otherwise serve the dead id for up to 1h).
   * Synchronous because the lookup entry is the one we just populated.
   */
  invalidateRepo(owner: string, repo: string): void;
}
