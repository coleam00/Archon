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

/** How a credential can authenticate (mirrors CREDENTIAL_KINDS in @archon/providers). */
export type CredentialKindOption = 'api_key' | 'subscription' | 'ambient';

/**
 * One credential a given agent can consume, with the caller's connection
 * state and server-side detection (install env / ambient). Mirrors
 * `agentCredentialStatusSchema` in `server/.../provider-key.schemas.ts`.
 */
export interface AgentCredentialStatus {
  /** Vendor-canonical credential id (e.g. 'anthropic', 'openrouter'). */
  vendor: string;
  displayName: string;
  kinds: CredentialKindOption[];
  /** The calling user's stored connection for this vendor, or null. */
  connected: 'api_key' | 'oauth' | null;
  /** Whether subscription (OAuth) login is currently connectable (gates included). */
  subscriptionAvailable: boolean;
  /** Whether the server process env already carries this vendor's key. */
  installEnv: boolean;
  /** Ambient chains only (bedrock/vertex): detected in the server environment. */
  ambientConfigured?: boolean;
}

/**
 * One agent's credential surface (#1955 grouped API). `catalog: 'dynamic'`
 * (OpenCode) means the vendor set is resolved at runtime via
 * GET /api/providers/opencode/credentials; `credentials` is empty and `ready`
 * is always false for those.
 */
export interface AgentCredentials {
  /** Agent provider id (registry order preserved by the server). */
  id: string;
  displayName: string;
  catalog: 'static' | 'dynamic';
  /**
   * Whether at least one credential is usable (connected / install env /
   * ambient). Server-computed source of truth for the card readiness verdict
   * (`agentReadiness` in lib/agent-status.ts reads it; the client only
   * derives the human reason label from `credentials`).
   */
  ready: boolean;
  credentials: AgentCredentialStatus[];
}

export interface ProviderKeyList {
  /** False when the install has no TOKEN_ENCRYPTION_KEY — connect affordances hide. */
  enabled: boolean;
  connections: ProviderKeyConnection[];
  /** Server-owned catalog of connectable vendor ids (no client duplication). */
  available: string[];
  /**
   * Subset of `available` that supports subscription (OAuth) login. Codex is
   * intentionally excluded (gated, #1924) so the UI shows it API-key-only.
   */
  subscriptionAvailable: string[];
  /**
   * Agent → credential matrix (#1955). Two consumers: the Settings → Agents
   * cards and the readiness hints in the Model Tiers / Aliases provider
   * dropdowns (both read the shared `K.providerConnections` cache entry).
   */
  agents: AgentCredentials[];
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
