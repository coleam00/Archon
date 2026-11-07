import type { components } from '@/lib/api.generated';
import { requestJson } from '../lib/http';

/**
 * Per-user AI-provider API keys (Settings → AI Provider Keys). Mirrors
 * `skills/github.ts`: thin `requestJson` verbs over the `/api/auth/providers`
 * routes.
 *
 * Filename is `providerKeys` (not `credentials`) to clear a user-global
 * Write/Edit guard hook that blocks basenames matching
 * `credential./secret./password./token.`.
 */

export type ProviderKeyConnection = components['schemas']['ProviderKeyConnection'];
export type AgentCredentialStatus = components['schemas']['AgentCredentialStatus'];
export type AgentCredentials = components['schemas']['AgentCredentials'];
export type ProviderKeyList = components['schemas']['ProviderKeyListResponse'];
export type ProviderKeySetResult = components['schemas']['ProviderKeySetResponse'];
export type ProviderOAuthStart = components['schemas']['ProviderOAuthStartResponse'];
export type ProviderOAuthPoll = components['schemas']['ProviderOAuthPollResponse'];

/** Begin a subscription (OAuth) login — held server-side by the oauth-bridge. */
export function startProviderOAuth(provider: string): Promise<ProviderOAuthStart> {
  return requestJson('/api/auth/providers/{provider}/oauth/start', 'post', {
    params: { provider },
  });
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
  return requestJson('/api/auth/providers/{provider}/oauth/poll', 'post', {
    params: { provider },
    body: (code
      ? { sessionId, code }
      : { sessionId }) satisfies components['schemas']['ProviderOAuthPollBody'],
  });
}

/** GET /api/auth/providers — 401s when there's no web identity (panel reads as "hide"). */
export function listProviderKeys(): Promise<ProviderKeyList> {
  return requestJson('/api/auth/providers', 'get');
}

/** PUT /api/auth/providers/:provider — stores the key encrypted; returns no secret. */
export function setProviderKey(
  provider: string,
  apiKey: string,
  label?: string
): Promise<ProviderKeySetResult> {
  return requestJson('/api/auth/providers/{provider}', 'put', {
    params: { provider },
    body: (label
      ? { apiKey, label }
      : { apiKey }) satisfies components['schemas']['ProviderKeySetBody'],
  });
}

/** DELETE /api/auth/providers/:provider — idempotent. */
export function deleteProviderKey(
  provider: string
): Promise<components['schemas']['ProviderKeyDeleteResponse']> {
  return requestJson('/api/auth/providers/{provider}', 'delete', {
    params: { provider },
  });
}
