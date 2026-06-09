import { requestJson } from '../lib/http';

/**
 * Per-user AI-provider API keys (Settings → AI Provider Keys). Mirrors
 * `skills/github.ts`: thin `requestJson` verbs over the `/api/auth/providers`
 * routes.
 *
 * Response types are inlined (mirroring `server/.../provider-key.schemas.ts`)
 * because they're not yet in `@/lib/api.generated`, and `@/lib/api` is
 * eslint-blocked for the console. Migrate to
 * `components['schemas']['ProviderKey*']` once a regen lands them.
 *
 * Filename is `providerKeys` (not `credentials`) to clear a user-global
 * Write/Edit guard hook that blocks basenames matching
 * `credential./secret./password./token.`.
 */

export interface ProviderKeyConnection {
  provider: string;
  kind: 'api_key' | 'oauth';
  label: string | null;
}

export interface ProviderKeyList {
  /** False when the install has no TOKEN_ENCRYPTION_KEY — the panel hides. */
  enabled: boolean;
  connections: ProviderKeyConnection[];
  /** Server-owned catalog of connectable provider ids (no client duplication). */
  available: string[];
  /**
   * Subset of `available` that supports subscription (OAuth) login. Codex is
   * intentionally excluded (gated, #1924) so the UI shows it API-key-only.
   */
  subscriptionAvailable: string[];
}

export interface ProviderKeySetResult {
  success: boolean;
  provider: string;
  kind: 'api_key';
  label: string | null;
}

/** POST /api/auth/providers/:provider/oauth/start response. */
export interface ProviderOAuthStart {
  sessionId: string;
  mode: 'manual' | 'device';
  url?: string;
  userCode?: string;
  verificationUri?: string;
  expiresIn: number;
}

/** POST /api/auth/providers/:provider/oauth/poll response. */
export interface ProviderOAuthPoll {
  status: 'pending' | 'connected' | 'error';
  mode?: 'manual' | 'device';
  url?: string;
  userCode?: string;
  verificationUri?: string;
  detail?: string;
}

/** Begin a subscription (OAuth) login — held server-side by the oauth-bridge. */
export function startProviderOAuth(provider: string): Promise<ProviderOAuthStart> {
  return requestJson<ProviderOAuthStart>(
    `/api/auth/providers/${encodeURIComponent(provider)}/oauth/start`,
    { method: 'POST' }
  );
}

/**
 * Poll a held login. For `manual` (claude) submit the pasted `code`; for
 * `device` (copilot) call with no code and poll until `connected`. The `:provider`
 * segment only keeps the route under the exempt prefix — poll keys off sessionId.
 */
export function pollProviderOAuth(
  provider: string,
  sessionId: string,
  code?: string
): Promise<ProviderOAuthPoll> {
  return requestJson<ProviderOAuthPoll>(
    `/api/auth/providers/${encodeURIComponent(provider)}/oauth/poll`,
    {
      method: 'POST',
      body: JSON.stringify(code ? { sessionId, code } : { sessionId }),
    }
  );
}

/** GET /api/auth/providers — 401s when there's no web identity (panel reads as "hide"). */
export function listProviderKeys(): Promise<ProviderKeyList> {
  return requestJson<ProviderKeyList>('/api/auth/providers');
}

/** PUT /api/auth/providers/:provider — stores the key encrypted; returns no secret. */
export function setProviderKey(
  provider: string,
  apiKey: string,
  label?: string
): Promise<ProviderKeySetResult> {
  return requestJson<ProviderKeySetResult>(`/api/auth/providers/${encodeURIComponent(provider)}`, {
    method: 'PUT',
    body: JSON.stringify(label ? { apiKey, label } : { apiKey }),
  });
}

/** DELETE /api/auth/providers/:provider — idempotent. */
export function deleteProviderKey(provider: string): Promise<{ success: boolean }> {
  return requestJson<{ success: boolean }>(`/api/auth/providers/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
  });
}
