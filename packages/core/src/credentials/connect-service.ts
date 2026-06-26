/**
 * Connect surface for per-user AI-provider credentials (Phase 2, PR-2).
 *
 * Persists the `api_key` credential kind: validate the provider is one the
 * delivery map actually understands (fail fast on a typo before we encrypt and
 * store a key we could never deliver), then upsert it encrypted via the store.
 *
 * Deliberately far thinner than `github-auth/connect-service.ts` — there is no
 * external identity to fetch and no identity to link / conflict-guard. The row
 * is keyed `(user_id, provider)` and the upsert is idempotent, so re-connecting
 * a provider just replaces the stored key. `persistProviderOAuth` (below) stores
 * the subscription credential blob the oauth-bridge mints.
 */
import { createLogger } from '@archon/paths';
import { normalizeCredentialVendor, type OAuthCredentials } from './delivery';
import { isConnectableVendor, listConnectableVendors } from './catalog';
import { SUBSCRIPTION_PROVIDERS } from './oauth-providers';
import { saveUserProviderKey } from '../db/user-provider-key-store';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('credentials.connect');
  return cachedLog;
}

/**
 * A caller-supplied input was invalid (blank key or unknown provider). Distinct
 * from a storage failure so the API layer can map it to a 400 with a safe,
 * caller-facing message, while encryption/DB errors stay opaque 500s and never
 * echo their internal message to the client.
 */
export class InvalidProviderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProviderKeyError';
  }
}

/** Secret-free result of a successful API-key connect — safe to return from an API. */
export interface PersistProviderApiKeyResult {
  provider: string;
  kind: 'api_key';
  label: string | null;
}

/**
 * Validate and store a user's API key for a credential vendor. Accepts legacy
 * agent-keyed ids (`claude`/`codex`/`copilot`) and stores under the
 * vendor-canonical id. Throws {@link InvalidProviderKeyError} (before any DB
 * write) when the key is blank or the vendor is not in the registry-derived
 * connectable catalog; any other throw is a storage failure. The plaintext key
 * is encrypted inside the store and is never logged.
 */
export async function persistProviderApiKey(
  userId: string,
  provider: string,
  apiKey: string,
  label?: string | null
): Promise<PersistProviderApiKeyResult> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new InvalidProviderKeyError('API key must not be empty.');
  }
  const vendor = normalizeCredentialVendor(provider);
  if (!isConnectableVendor(vendor)) {
    throw new InvalidProviderKeyError(
      `Unknown provider '${provider}'. Known: ${listConnectableVendors().join(', ')}.`
    );
  }
  const normalizedLabel = label?.trim() || null;
  await saveUserProviderKey({
    userId,
    provider: vendor,
    kind: 'api_key',
    apiKey: trimmedKey,
    label: normalizedLabel,
  });
  // Never log the key value — vendor + user only.
  getLog().info({ userId, provider: vendor }, 'provider_api_key.persisted');
  return { provider: vendor, kind: 'api_key', label: normalizedLabel };
}

/** Secret-free result of a successful subscription (OAuth) connect. */
export interface PersistProviderOAuthResult {
  provider: string;
  kind: 'oauth';
}

/**
 * Store a user's OAuth subscription credential blob for a vendor. Accepts
 * legacy agent-keyed ids and stores under the vendor-canonical id. Throws
 * {@link InvalidProviderKeyError} when the vendor has no subscription flow
 * (`anthropic`/`openai`/`github-copilot` today). The blob is encrypted inside
 * the store and never logged; it's refreshed on read by
 * `getDecryptedProviderCredential`.
 */
export async function persistProviderOAuth(
  userId: string,
  provider: string,
  oauthCreds: OAuthCredentials
): Promise<PersistProviderOAuthResult> {
  const vendor = normalizeCredentialVendor(provider);
  if (!SUBSCRIPTION_PROVIDERS.has(vendor)) {
    throw new InvalidProviderKeyError(
      `Provider '${provider}' does not support subscription login. ` +
        `Subscription providers: ${[...SUBSCRIPTION_PROVIDERS].sort().join(', ')}.`
    );
  }
  await saveUserProviderKey({
    userId,
    provider: vendor,
    kind: 'oauth',
    oauthCreds,
    label: 'subscription',
  });
  getLog().info({ userId, provider: vendor }, 'provider_oauth.persisted');
  return { provider: vendor, kind: 'oauth' };
}
