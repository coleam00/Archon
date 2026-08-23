/**
 * SDK-boundary wrapper around Pi's OAuth utilities (`@earendil-works/pi-ai`).
 *
 * The Pi SDK dependency lives only in `@archon/providers`, so the rest of
 * Archon (the credential store + the subscription-connect bridge in
 * `@archon/core`) drives OAuth THROUGH this module instead of importing the
 * SDK directly. Pi 0.84.0 reorganized its public surface — the
 * `getOAuthProvider`/`getOAuthApiKey`/`OAuthProviderInterface` exports that
 * `@archon/core` calls were dropped from the SDK. This module now owns those
 * shapes locally and adapts the new `OAuthAuth` singletons (anthropic, github
 * copilot) to the legacy callback-driven interface the bridge and key-store
 * still speak. The legacy `openaiCodexOAuthProvider` export is intentionally
 * absent — see the `getOAuthProvider` note below.
 *
 * Why this serves more than Pi: Pi's OAuth flows authenticate against the
 * native runtimes' OWN OAuth apps (the Claude Code app, the GitHub Copilot
 * device flow), so the token Pi mints is exactly what the native
 * Claude/Copilot providers already accept. One subscription connect therefore
 * powers the native runtimes, not just Pi — the delivery map
 * (`@archon/core/credentials/delivery`) routes the resolved credential to
 * whichever provider consumes it.
 */

import type {
  OAuthAuth,
  OAuthCredential,
  ProviderAuthInteraction,
  AuthPrompt,
  AuthEvent,
} from '@earendil-works/pi-ai';

/* ─── Lazy loader for the SDK's OAuth singletons ──────────────────────────── */

/**
 * The SDK ships `anthropicOAuth` and `githubCopilotOAuth` as deep subpath
 * modules (`@earendil-works/pi-ai/dist/auth/oauth/anthropic`) but those
 * subpaths are NOT in the package's `exports` field, so a static ESM import
 * fails with "Cannot find module". Bun enforces the exports gate the same
 * way Node.js does. We resolve them lazily through `createRequire` against
 * the SDK's own package root on first use, caching the resolved singletons
 * for subsequent calls.
 *
 * The lazy loader is intentional: a top-level static import would fail at
 * module-init time even when the OAuth code paths are never reached.
 */
interface AnthropicOAuthModule {
  anthropicOAuth: OAuthAuth;
}
interface GithubCopilotOAuthModule {
  githubCopilotOAuth: OAuthAuth;
}
type ProviderLoader = () => Promise<OAuthAuth>;

let anthropicOAuthCache: OAuthAuth | undefined;
let githubCopilotOAuthCache: OAuthAuth | undefined;

async function loadAnthropicOAuth(): Promise<OAuthAuth> {
  if (anthropicOAuthCache) return anthropicOAuthCache;
  // Resolve the SDK package root via its public `package.json` (the only
  // subpath that IS in `exports`), then drill down to the deep file. This
  // stays inside the SDK's installed location — the `exports` gate is
  // bypassed because we go through the filesystem, not the resolver.
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const sdkPkgUrl = import.meta.resolve('@earendil-works/pi-ai/package.json');
  const sdkPkgPath = fileURLToPath(sdkPkgUrl);
  const sdkRoot = sdkPkgPath.replace(/\/package\.json$/, '');
  const deepPath = `${sdkRoot}/dist/auth/oauth/anthropic.js`;

  const require = createRequire(import.meta.url);
  const mod = require(deepPath) as AnthropicOAuthModule;
  anthropicOAuthCache = mod.anthropicOAuth;
  return anthropicOAuthCache;
}

async function loadGithubCopilotOAuth(): Promise<OAuthAuth> {
  if (githubCopilotOAuthCache) return githubCopilotOAuthCache;
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const sdkPkgUrl = import.meta.resolve('@earendil-works/pi-ai/package.json');
  const sdkPkgPath = fileURLToPath(sdkPkgUrl);
  const sdkRoot = sdkPkgPath.replace(/\/package\.json$/, '');
  const deepPath = `${sdkRoot}/dist/auth/oauth/github-copilot.js`;

  const require = createRequire(import.meta.url);
  const mod = require(deepPath) as GithubCopilotOAuthModule;
  githubCopilotOAuthCache = mod.githubCopilotOAuth;
  return githubCopilotOAuthCache;
}

async function loadProvider(loader: ProviderLoader): Promise<OAuthAuth> {
  return loader();
}

/* ─── Legacy surface preserved for `@archon/core` consumers ───────────────── */

/** Subset of the pre-0.84 callback-driven login surface the bridge relies on. */
export interface OAuthLoginCallbacks {
  onAuth(info: { url: string; instructions?: string }): void;
  onDeviceCode(info: { userCode: string; verificationUri: string }): void;
  onManualCodeInput?(): Promise<string>;
  onPrompt(prompt: unknown): Promise<string>;
  onSelect(prompt: {
    options: readonly { id: string; label?: string }[];
  }): Promise<string | undefined>;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}

/** Legacy `OAuthCredentials` re-export (pi-ai ships an identical shape). */
export type OAuthCredentials = OAuthCredential;

/** Legacy `OAuthAuthInfo` / `OAuthDeviceCodeInfo` — preserved for callers. */
export interface OAuthAuthInfo {
  url: string;
  instructions?: string;
}
export interface OAuthDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
}

/**
 * Pre-0.84 OAuth provider singleton shape: an `id` for the key-store path,
 * an opt-in `usesCallbackServer` flag (Anthropic + the now-Archon-owned
 * OpenAI Codex bind a local fixed-port callback server during login; the
 * bridge uses this flag to supersede colliding in-flight logins), and the
 * `login` / `refreshToken` / `getApiKey` methods.
 */
export interface OAuthProviderInterface {
  readonly id: string;
  readonly name: string;
  readonly usesCallbackServer?: boolean;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredential>;
  refreshToken(
    credentials: OAuthCredential,
    options?: { signal?: AbortSignal }
  ): Promise<OAuthCredential>;
  getApiKey(credentials: OAuthCredential): Promise<{ apiKey: string }>;
}

export type OAuthProviderId = 'anthropic' | 'github-copilot';

/* ─── Adapter: `OAuthAuth` (pi-ai ≥ 0.84) → legacy callback-driven surface ── */

/**
 * Map a single `interaction` method call into the matching legacy callback.
 * Pure dispatch — the real prompts/events live in `interaction.ts` below.
 */
function adaptLoginCallbacks(
  oauthAuth: OAuthAuth,
  callbacks: OAuthLoginCallbacks
): ProviderAuthInteraction {
  return {
    signal: callbacks.signal ?? new AbortController().signal,
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === 'manual_code') {
        if (!callbacks.onManualCodeInput) {
          throw new Error(
            `OAuth provider '${oauthAuth.name}' requested a manual code but no onManualCodeInput callback was supplied.`
          );
        }
        return callbacks.onManualCodeInput();
      }
      if (prompt.type === 'select') {
        return (await callbacks.onSelect({ options: prompt.options })) ?? '';
      }
      // text / secret — Pi uses these for one-off prompts (e.g. github-copilot
      // enterprise domain). The bridge routes them to the same code-deferred.
      return callbacks.onPrompt(prompt);
    },
    notify: (event: AuthEvent): void => {
      if (event.type === 'auth_url') {
        callbacks.onAuth({ url: event.url, instructions: event.instructions });
        return;
      }
      if (event.type === 'device_code') {
        callbacks.onDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
        });
        return;
      }
      if (event.type === 'progress') {
        callbacks.onProgress?.(event.message);
        return;
      }
      if (event.type === 'info') {
        callbacks.onProgress?.(event.message);
        return;
      }
    },
  };
}

/**
 * Wrap a pi-ai 0.84.0 `OAuthAuth` singleton in the legacy
 * `OAuthProviderInterface` shape. The id + name are caller-supplied because
 * pi-ai's `OAuthAuth` doesn't carry an Archon-style vendor id (only a
 * human-readable display name).
 */
function adaptOAuthAuth(
  id: string,
  loader: ProviderLoader,
  usesCallbackServer: boolean
): OAuthProviderInterface {
  return {
    id,
    name: '',
    usesCallbackServer,
    async login(callbacks): Promise<OAuthCredential> {
      const oauthAuth = await loadProvider(loader);
      return oauthAuth.login(adaptLoginCallbacks(oauthAuth, callbacks));
    },
    async refreshToken(credentials, options): Promise<OAuthCredential> {
      const oauthAuth = await loadProvider(loader);
      const signal = options?.signal ?? new AbortController().signal;
      return oauthAuth.refresh(credentials, signal);
    },
    async getApiKey(credentials): Promise<{ apiKey: string }> {
      const oauthAuth = await loadProvider(loader);
      // toAuth returns a ModelAuth ({ apiKey?, headers?, baseUrl? }); the
      // explicit shape annotation here lets TS narrow against the field
      // without trying to widen AuthResult into ModelAuth.
      const auth = await oauthAuth.toAuth(credentials);
      if (!auth.apiKey) {
        throw new Error(
          `Pi OAuth provider '${oauthAuth.name}' produced no apiKey for the stored credential.`
        );
      }
      return { apiKey: auth.apiKey };
    },
  };
}

export const anthropicOAuthProvider: OAuthProviderInterface = adaptOAuthAuth(
  'anthropic',
  loadAnthropicOAuth,
  true
);
export const githubCopilotOAuthProvider: OAuthProviderInterface = adaptOAuthAuth(
  'github-copilot',
  loadGithubCopilotOAuth,
  false
);

/**
 * Returns the `OAuthProviderInterface` for the given vendor id, or undefined
 * if the vendor is API-key only or its flow is Archon-owned (the
 * `openai`/ChatGPT Codex flow runs through `@archon/core`'s PKCE module —
 * see `credentials/openai-oauth.ts`; it would drop the `id_token` the Codex
 * CLI requires, #1924, so it is deliberately NOT exposed here).
 */
export function getOAuthProvider(id: string): OAuthProviderInterface | undefined {
  switch (id) {
    case 'anthropic':
      return anthropicOAuthProvider;
    case 'github-copilot':
      return githubCopilotOAuthProvider;
    default:
      return undefined;
  }
}

/* ─── Auto-refresh + mint: the key-store calls `getOAuthApiKey(...)` ───────── */

/**
 * Mint a usable bearer from a stored OAuth blob; auto-refresh on expiry.
 *
 * Mirrors the pre-0.84 `getOAuthApiKey` contract that
 * `@archon/core/db/user-provider-key-store.ts` consumes:
 *   - input: `{ [providerId]: creds }` — the key-store destructures by id to
 *     stay vendor-agnostic (`piProvider.id` is the key it uses)
 *   - output: `{ newCredentials, apiKey }` if a usable key (with `newCredentials`
 *     populated iff the refresh path rotated the blob) or `null` if no provider
 *     backs this vendor
 *
 * The new SDK splits the pre-0.84 helpers into two `OAuthAuth` methods —
 * `toAuth(credential)` for the no-rotation path and `refresh(credential,
 * signal)` for rotation — and re-glues them here. Throws on a hard auth
 * failure (HTTP 401, invalid_grant, etc.) so the caller can record a
 * `user_provider_key.oauth_refresh_failed` observatory event.
 */
export async function getOAuthApiKey(
  providerId: string,
  options: Record<string, OAuthCredential> & { signal?: AbortSignal }
): Promise<{ newCredentials: OAuthCredential; apiKey: string } | null> {
  const provider = getOAuthProvider(providerId);
  if (!provider) return null;
  const creds = options[providerId];
  try {
    const minted = await provider.getApiKey(creds);
    // No rotation: `newCredentials` echoes the input so callers can compare
    // against the stored blob without branching on the rotation status
    // (matches the pre-0.84 contract the key-store relies on).
    return { newCredentials: creds, apiKey: minted.apiKey };
  } catch (firstErr) {
    // Rotation path: refresh the credential, then mint. Refreshers return a
    // brand-new credential (refresh token rotated on the server side), which
    // the caller saves via `saveUserProviderKey(...)` so the next read
    // doesn't re-refresh.
    let refreshed: OAuthCredential;
    try {
      refreshed = await provider.refreshToken(creds, { signal: options.signal });
    } catch (refreshErr) {
      const firstMessage = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const refreshMessage = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
      throw new Error(
        `Pi OAuth credential for '${providerId}' could not be minted (${firstMessage}); refresh also failed: ${refreshMessage}`
      );
    }
    const minted = await provider.getApiKey(refreshed);
    return { newCredentials: refreshed, apiKey: minted.apiKey };
  }
}
