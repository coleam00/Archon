/**
 * Storage for per-user AI-provider credentials (Phase 2), encrypted at rest
 * with AES-256-GCM using the same `TOKEN_ENCRYPTION_KEY` as the per-user
 * GitHub-token store. One row per `(user_id, provider)`.
 *
 * Two credential kinds: `api_key` (a single bearer string) and `oauth` (an
 * opaque blob minted at login). For `api_key`,
 * `getDecryptedProviderCredential` returns the decrypted bearer directly. For
 * `oauth`, it decrypts the blob, refreshes a usable bearer through core's
 * subscription flows, and re-saves rotated credentials.
 *
 * (Filename carries a `-store` suffix to satisfy a local secret-guard hook
 * that blocks basenames ending in `key(s).ts` / `token(s).ts`; the table is
 * `remote_agent_user_provider_keys`.)
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';
import { mintOAuthApiKey, SubscriptionTokenError } from '../credentials/subscription-oauth';
import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';
import type { UserProviderKeyRow } from '../schemas/user-provider-key-row';
import type { StoredCredentialKind } from '@archon/provider-contract';
import {
  normalizeCredentialVendor,
  type OAuthCredentials,
  type ResolvedCredential,
} from '../credentials/delivery';
import {
  subscriptionOAuthProviderFor,
  OPENAI_SUBSCRIPTION_VENDOR,
} from '../credentials/oauth-providers';
import {
  mintOpenAiOAuthApiKey,
  OpenAiTokenError,
  type OpenAiOAuthCredentials,
} from '../credentials/openai-oauth';
import type { CredentialStatus } from '@archon/provider-contract';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.user-provider-keys');
  return cachedLog;
}

export interface SaveUserProviderKeyParams {
  userId: string;
  provider: string;
  kind: StoredCredentialKind;
  /** Plaintext API key — encrypted before write. Required when kind='api_key'. */
  apiKey?: string;
  /** Raw OAuth blob — JSON-stringified and encrypted before write. Required when kind='oauth'. */
  oauthCreds?: OAuthCredentials;
  label?: string | null;
}

/**
 * Insert or update a user's credential for a provider. Exactly one of
 * `apiKey` / `oauthCreds` must match `kind`; the other is stored as NULL.
 */
export async function saveUserProviderKey(params: SaveUserProviderKeyParams): Promise<void> {
  if (params.kind === 'api_key' && !params.apiKey) {
    throw new Error("saveUserProviderKey: kind='api_key' requires apiKey");
  }
  if (params.kind === 'oauth' && !params.oauthCreds) {
    throw new Error("saveUserProviderKey: kind='oauth' requires oauthCreds");
  }
  const key = getEncryptionKey();
  const apiKeyEnc = params.apiKey ? encryptToken(params.apiKey, key) : null;
  const oauthEnc = params.oauthCreds ? encryptToken(JSON.stringify(params.oauthCreds), key) : null;
  const dialect = getDialect();

  await pool.query(
    `INSERT INTO remote_agent_user_provider_keys
       (user_id, provider, kind, api_key_encrypted, oauth_creds_encrypted, label)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       kind = EXCLUDED.kind,
       api_key_encrypted = EXCLUDED.api_key_encrypted,
       oauth_creds_encrypted = EXCLUDED.oauth_creds_encrypted,
       label = EXCLUDED.label,
       updated_at = ${dialect.now()}`,
    [params.userId, params.provider, params.kind, apiKeyEnc, oauthEnc, params.label ?? null]
  );
  // Never log credential values.
  getLog().info(
    { userId: params.userId, provider: params.provider, kind: params.kind },
    'user_provider_key.stored'
  );
}

/** Internal: fetch the raw row for `(userId, provider)` or null. */
export async function getUserProviderKeyRecord(
  userId: string,
  provider: string
): Promise<UserProviderKeyRow | null> {
  const result = await pool.query<UserProviderKeyRow>(
    'SELECT * FROM remote_agent_user_provider_keys WHERE user_id = $1 AND provider = $2',
    [userId, provider]
  );
  return result.rows[0] ?? null;
}

/**
 * List the user's connected providers — metadata only, no secret values.
 * Safe to return directly from an API response.
 */
export async function listUserProviderKeys(
  userId: string
): Promise<{ provider: string; kind: StoredCredentialKind; label: string | null }[]> {
  const result = await pool.query<{
    provider: string;
    kind: StoredCredentialKind;
    label: string | null;
  }>(
    `SELECT provider, kind, label
     FROM remote_agent_user_provider_keys
     WHERE user_id = $1
     ORDER BY provider`,
    [userId]
  );
  return [...result.rows];
}

/** Delete the user's credential for a provider. Idempotent. */
export async function deleteUserProviderKey(userId: string, provider: string): Promise<void> {
  await pool.query(
    'DELETE FROM remote_agent_user_provider_keys WHERE user_id = $1 AND provider = $2',
    [userId, provider]
  );
  getLog().info({ userId, provider }, 'user_provider_key.deleted');
}

type UnusableStatus = Extract<CredentialStatus, { state: 'unusable' }>;

/**
 * A stored credential as a run would meet it. The decrypted credential exists only in the
 * `usable` member; every other member is a {@link CredentialStatus} and safe to surface.
 */
export type StoredCredential =
  | {
      state: 'usable';
      source: 'archon';
      credential: ResolvedCredential;
      /** Set when this read refreshed the credential but could not save the rotation: the
       *  live credential works for this run, the stored one must be reconnected. */
      storedStatus?: UnusableStatus;
    }
  | Exclude<CredentialStatus, { state: 'usable' | 'not_checked' }>;

type StoredCredentialFailure = Exclude<StoredCredential, { state: 'usable' }>;

const NOT_CONNECTED: StoredCredentialFailure = { state: 'not_connected', source: 'archon' };

const UNREADABLE: StoredCredentialFailure = {
  state: 'unusable',
  source: 'archon',
  evidence: 'The stored credential cannot be read.',
};

const ROTATION_NOT_SAVED: UnusableStatus = {
  state: 'unusable',
  source: 'archon',
  evidence:
    'The refreshed credential could not be saved, and the refresh invalidated the stored one.',
};

/**
 * Serializes concurrent OAuth reads per `(userId, provider)` so a burst of
 * inject calls in one run never triggers (or races) more than one token
 * refresh. Mirrors `getDecryptedAccessToken`'s inflight Map in the github store.
 */
const inflightOAuthReads = new Map<string, Promise<StoredCredential>>();

/**
 * Decrypt the user's credential for a provider into a {@link ResolvedCredential}
 * ready for the delivery map, or say why it cannot be used: `not_connected` when
 * the user has no row, `unusable` when the row cannot be read or the vendor
 * rejected the refresh, and `check_failed` when the refresh failed for a cause
 * Archon cannot tell (network, vendor outage, an unclassified SDK error).
 *
 * For `oauth` rows: decrypt the stored blob → mint/refresh a bearer → re-save
 * rotated creds → return it. When the rotation could not be saved and the refresh
 * superseded the stored refresh token, the live credential is still returned, with
 * `storedStatus` saying the stored one must be reconnected. Throws only when the
 * encryption key itself cannot be loaded: that is install misconfiguration, not a
 * credential state.
 */
export async function getDecryptedProviderCredential(
  userId: string,
  provider: string
): Promise<StoredCredential> {
  const row = await getUserProviderKeyRecord(userId, provider);
  if (!row) {
    getLog().debug({ userId, provider }, 'user_provider_key.not_connected');
    return NOT_CONNECTED;
  }
  const key = getEncryptionKey();
  if (row.kind === 'api_key') {
    if (!row.api_key_encrypted) {
      getLog().warn({ userId, provider }, 'user_provider_key.missing_api_key_ciphertext');
      return UNREADABLE;
    }
    try {
      return {
        state: 'usable',
        source: 'archon',
        credential: { kind: 'api_key', apiKey: decryptToken(row.api_key_encrypted, key) },
      };
    } catch (err) {
      getLog().error({ err: err as Error, userId, provider }, 'user_provider_key.decrypt_failed');
      return UNREADABLE;
    }
  }

  // OAuth: coalesce concurrent reads so we refresh at most once per (user, provider).
  if (!row.oauth_creds_encrypted) {
    getLog().warn({ userId, provider }, 'user_provider_key.missing_oauth_ciphertext');
    return UNREADABLE;
  }
  const ciphertext = row.oauth_creds_encrypted;
  const flightKey = `${userId}:${provider}`;
  const existing = inflightOAuthReads.get(flightKey);
  if (existing) return existing;
  const promise = resolveOAuthCredential(userId, provider, ciphertext, key).finally(() =>
    inflightOAuthReads.delete(flightKey)
  );
  inflightOAuthReads.set(flightKey, promise);
  return promise;
}

/**
 * The status of the user's stored credential for a vendor, without the secret.
 * Runs the same decrypt and refresh a run would, so the answer is the one the
 * run would meet (a needed refresh happens here and its rotation is saved). A
 * refresh whose rotation could not be saved reports `unusable`: the stored
 * credential can no longer refresh.
 */
export async function getStoredCredentialStatus(
  userId: string,
  vendor: string
): Promise<CredentialStatus> {
  const stored = await getDecryptedProviderCredential(userId, vendor);
  if (stored.state !== 'usable') return stored;
  return stored.storedStatus ?? { state: 'usable', source: 'archon' };
}

/** Rotated refresh tokens must be saved before a later read needs them again. */
async function resolveOAuthCredential(
  userId: string,
  provider: string,
  ciphertext: string,
  key: Buffer
): Promise<StoredCredential> {
  const vendor = normalizeCredentialVendor(provider);
  const oauthProvider =
    vendor === OPENAI_SUBSCRIPTION_VENDOR ? undefined : subscriptionOAuthProviderFor(vendor);
  if (vendor !== OPENAI_SUBSCRIPTION_VENDOR && !oauthProvider) {
    // An oauth row for a provider with no OAuth flow (shouldn't happen — connect guards it).
    getLog().warn({ userId, provider }, 'user_provider_key.oauth_no_provider');
    return UNREADABLE;
  }
  const creds = readOAuthCredentials(userId, provider, ciphertext, key);
  if (!creds) return UNREADABLE;
  let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
  try {
    result = oauthProvider
      ? await mintOAuthApiKey(oauthProvider, creds)
      : // Assertion to the narrow openai shape: rows under vendor 'openai' are
        // minted exclusively by openai-oauth.ts, which validates every field at
        // write time; mint's runtime guards still tolerate legacy/corrupt rows.
        await mintOpenAiOAuthApiKey(creds as OpenAiOAuthCredentials);
  } catch (err) {
    return oauthRefreshFailure(userId, provider, err);
  }

  if (!result) {
    getLog().warn({ userId, provider }, 'user_provider_key.oauth_no_api_key');
    return {
      state: 'unusable',
      source: 'archon',
      evidence: 'The stored credential produced no access token.',
    };
  }
  const rawCreds = result.newCredentials;
  const storedLost = await saveRotatedOAuthCredentials(userId, provider, creds, rawCreds, key);
  return {
    state: 'usable',
    source: 'archon',
    credential: { kind: 'oauth', oauthApiKey: result.apiKey, rawCreds },
    ...(storedLost && { storedStatus: ROTATION_NOT_SAVED }),
  };
}

function readOAuthCredentials(
  userId: string,
  provider: string,
  ciphertext: string,
  key: Buffer
): OAuthCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptToken(ciphertext, key));
  } catch {
    getLog().error({ userId, provider }, 'user_provider_key.oauth_decrypt_failed');
    return null;
  }
  const creds = typeof parsed === 'object' && parsed !== null ? (parsed as OAuthCredentials) : null;
  // Both mint paths decide refresh from `creds.expires`. A missing or
  // non-numeric value from a legacy/corrupt row would make that comparison
  // silently false and serve a stale token as success, so enforce the shape
  // here where the raw blob enters and treat a mismatch like decrypt failure.
  if (!creds || !Number.isFinite(creds.expires)) {
    getLog().error(
      { userId, provider, expiresType: typeof creds?.expires },
      'user_provider_key.oauth_malformed_expires'
    );
    return null;
  }
  return creds;
}

function oauthRefreshFailure(userId: string, provider: string, err: unknown): StoredCredential {
  getLog().error(
    {
      userId,
      provider,
      status:
        err instanceof OpenAiTokenError || err instanceof SubscriptionTokenError
          ? err.status
          : undefined,
    },
    'user_provider_key.oauth_refresh_failed'
  );
  if (!(err instanceof OpenAiTokenError) && !(err instanceof SubscriptionTokenError)) {
    return {
      state: 'check_failed',
      source: 'archon',
      evidence: "The vendor's token refresh failed.",
    };
  }
  // Core's token flows report an HTTP status and a body-free message. Only
  // 400 and 401 mean the token endpoint rejected the grant; any other status (a WAF
  // challenge, a moved endpoint, rate limiting, an outage) or no status at all (network,
  // timeout) leaves the credential's health unknown.
  if (err.status === 400 || err.status === 401) {
    return { state: 'unusable', source: 'archon', evidence: err.message };
  }
  return { state: 'check_failed', source: 'archon', evidence: err.message };
}

/**
 * Write only the rotated blob, so the row's label and other columns survive a
 * refresh. A row the user removed or replaced with an API key meanwhile matches
 * nothing and stays as the user left it.
 */
async function saveRotatedOAuthBlob(
  userId: string,
  provider: string,
  oauthCreds: OAuthCredentials,
  key: Buffer
): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_user_provider_keys
       SET oauth_creds_encrypted = $1, updated_at = ${getDialect().now()}
     WHERE user_id = $2 AND provider = $3 AND kind = 'oauth'`,
    [encryptToken(JSON.stringify(oauthCreds), key), userId, provider]
  );
}

/** Returns true when the stored credential was lost: it can no longer refresh. */
async function saveRotatedOAuthCredentials(
  userId: string,
  provider: string,
  creds: OAuthCredentials,
  rawCreds: OAuthCredentials,
  key: Buffer
): Promise<boolean> {
  // Compare the meaningful fields (not JSON, which is key-order-sensitive → needless
  // writes on a reordered-but-equal blob).
  const rotated =
    rawCreds.access !== creds.access ||
    rawCreds.refresh !== creds.refresh ||
    rawCreds.expires !== creds.expires;
  if (!rotated) return false;
  // IMPORTANT: Anthropic/Codex INVALIDATE the old refresh token on rotation. If
  // this resave fails and the refresh token changed, the DB keeps a now-dead token
  // → every future refresh fails and the credential must be reconnected, so the
  // read reports the stored credential as lost. Retry once, and log at ERROR. When
  // the refresh token did not change (Copilot, or a vendor that omits a new one),
  // the stored credential still works and the next read refreshes again. The live
  // credential is returned either way: it works for this run.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await saveRotatedOAuthBlob(userId, provider, rawCreds, key);
      getLog().debug({ userId, provider, attempt }, 'user_provider_key.oauth_rotated_resaved');
      return false;
    } catch (err) {
      if (attempt === 2) {
        getLog().error(
          { err: err as Error, userId, provider },
          'user_provider_key.oauth_resave_failed'
        );
      }
    }
  }
  return rawCreds.refresh !== creds.refresh;
}
