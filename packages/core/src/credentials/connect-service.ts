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
 * a provider just replaces the stored key. OAuth subscription persistence lands
 * with the Pi OAuth bridge in PR-3.
 */
import { createLogger } from '@archon/paths';
import { KNOWN_PROVIDERS } from './delivery';
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
 * Validate and store a user's API key for `provider`. Throws
 * {@link InvalidProviderKeyError} (before any DB write) when the key is blank or
 * the provider is not in {@link KNOWN_PROVIDERS}; any other throw is a storage
 * failure. The plaintext key is encrypted inside the store and is never logged.
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
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new InvalidProviderKeyError(
      `Unknown provider '${provider}'. Known: ${[...KNOWN_PROVIDERS].sort().join(', ')}.`
    );
  }
  const normalizedLabel = label?.trim() || null;
  await saveUserProviderKey({
    userId,
    provider,
    kind: 'api_key',
    apiKey: trimmedKey,
    label: normalizedLabel,
  });
  // Never log the key value — provider + user only.
  getLog().info({ userId, provider }, 'provider_api_key.persisted');
  return { provider, kind: 'api_key', label: normalizedLabel };
}
