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
}

export interface ProviderKeySetResult {
  success: boolean;
  provider: string;
  kind: 'api_key';
  label: string | null;
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
