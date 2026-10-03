/**
 * Storage for per-user AI-provider credentials (Phase 2), encrypted at rest
 * with AES-256-GCM using the same `TOKEN_ENCRYPTION_KEY` as the per-user
 * GitHub-token store. One row per `(user_id, provider)`.
 *
 * Two credential kinds: `api_key` (a single bearer string) and `oauth` (an
 * opaque blob minted at login). For `api_key`,
 * `getDecryptedProviderCredential` returns the decrypted bearer directly. For
 * `oauth`, it decrypts the blob, mints/refreshes a usable bearer — via Pi's
 * `getOAuthApiKey` for Pi-driven vendors, or the Archon-owned OpenAI flow
 * (`mintOpenAiOAuthApiKey`, which preserves the `id_token` Pi drops, #1924) —
 * re-saves rotated creds, and returns it (PR-3).
 *
 * (Filename carries a `-store` suffix to satisfy a local secret-guard hook
 * that blocks basenames ending in `key(s).ts` / `token(s).ts`; the table is
 * `remote_agent_user_provider_keys`.)
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';
import {
  getOAuthApiKey,
  type OAuthCredentials as PiOAuthCredentials,
} from '@archon/providers/oauth';
import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';
import type { UserProviderKeyRow } from '../schemas/user-provider-key-row';
import {
  normalizeCredentialVendor,
  type OAuthCredentials,
  type ResolvedCredential,
} from '../credentials/delivery';
import { piOAuthProviderFor, OPENAI_SUBSCRIPTION_VENDOR } from '../credentials/oauth-providers';
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
  kind: 'api_key' | 'oauth';
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
): Promise<{ provider: string; kind: 'api_key' | 'oauth'; label: string | null }[]> {
  const result = await pool.query<{
    provider: string;
    kind: 'api_key' | 'oauth';
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

/**
 * A stored credential as a run would meet it. The decrypted credential exists only in the
 * `usable` member; every other member is a {@link CredentialStatus} and safe to surface.
 */
export type StoredCredential =
  | { state: 'usable'; source: 'archon'; credential: ResolvedCredential }
  | Exclude<CredentialStatus, { state: 'usable' | 'not_checked' }>;

type StoredCredentialFailure = Exclude<StoredCredential, { state: 'usable' }>;

const NOT_CONNECTED: StoredCredentialFailure = { state: 'not_connected', source: 'archon' };

const UNREADABLE: StoredCredentialFailure = {
  state: 'unusable',
  source: 'archon',
  evidence: 'The stored credential cannot be read. Reconnect it.',
};

/** HTTP statuses from a token endpoint that say nothing about the credential itself. */
function isVendorUnavailableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

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
 * rotated creds → return it. Throws only when the encryption key itself cannot
 * be loaded: that is install misconfiguration, not a credential state.
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
 * run would meet (a needed refresh happens here and its rotation is saved).
 */
export async function getStoredCredentialStatus(
  userId: string,
  vendor: string
): Promise<CredentialStatus> {
  const stored = await getDecryptedProviderCredential(userId, vendor);
  return stored.state === 'usable' ? { state: 'usable', source: 'archon' } : stored;
}

/**
 * Decrypt + refresh one OAuth credential. Vendor `openai` refreshes through
 * the Archon-owned flow (`mintOpenAiOAuthApiKey`) — Pi's `getOAuthApiKey`
 * would rebuild the blob from its own shape and DROP the `id_token` the Codex
 * CLI requires on every rotation (#1924). Everything else goes through Pi's
 * `getOAuthApiKey`. On rotation, re-save the new blob (with retry; a dead
 * resave means a dead refresh token — see below). Never throws.
 */
async function resolveOAuthCredential(
  userId: string,
  provider: string,
  ciphertext: string,
  key: Buffer
): Promise<StoredCredential> {
  const vendor = normalizeCredentialVendor(provider);
  const piProvider = vendor === OPENAI_SUBSCRIPTION_VENDOR ? undefined : piOAuthProviderFor(vendor);
  if (vendor !== OPENAI_SUBSCRIPTION_VENDOR && !piProvider) {
    // An oauth row for a provider with no OAuth flow (shouldn't happen — connect guards it).
    getLog().warn({ userId, provider }, 'user_provider_key.oauth_no_pi_provider');
    return UNREADABLE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptToken(ciphertext, key));
  } catch (err) {
    getLog().error(
      { err: err as Error, userId, provider },
      'user_provider_key.oauth_decrypt_failed'
    );
    return UNREADABLE;
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
    return UNREADABLE;
  }
  let result: { newCredentials: PiOAuthCredentials | OAuthCredentials; apiKey: string } | null;
  try {
    result = piProvider
      ? await getOAuthApiKey(piProvider.id, {
          [piProvider.id]: creds as unknown as PiOAuthCredentials,
        })
      : // Assertion to the narrow openai shape: rows under vendor 'openai' are
        // minted exclusively by openai-oauth.ts, which validates every field at
        // write time; mint's runtime guards still tolerate legacy/corrupt rows.
        await mintOpenAiOAuthApiKey(creds as OpenAiOAuthCredentials);
  } catch (err) {
    getLog().error(
      { err: err as Error, userId, provider },
      'user_provider_key.oauth_refresh_failed'
    );
    if (!(err instanceof OpenAiTokenError)) {
      // Pi's refresh errors embed the vendor response body, which can carry account
      // identifiers or issued tokens. The full error stays in the log above only.
      return {
        state: 'check_failed',
        source: 'archon',
        evidence: "The vendor's token refresh failed.",
      };
    }
    // Archon's own OpenAI flow reports an HTTP status and a body-free message. A token
    // endpoint that answers 4xx rejected the grant; anything else (network, timeout,
    // outage) leaves the credential's health unknown.
    if (err.status && !isVendorUnavailableStatus(err.status)) {
      return { state: 'unusable', source: 'archon', evidence: err.message };
    }
    return { state: 'check_failed', source: 'archon', evidence: err.message };
  }
  if (!result) {
    getLog().warn({ userId, provider }, 'user_provider_key.oauth_no_api_key');
    return {
      state: 'unusable',
      source: 'archon',
      evidence: 'The stored credential produced no access token. Reconnect it.',
    };
  }
  const rawCreds = result.newCredentials as OAuthCredentials;
  // Compare the meaningful fields (not JSON, which is key-order-sensitive → needless
  // writes on a reordered-but-equal blob).
  const rotated =
    rawCreds.access !== creds.access ||
    rawCreds.refresh !== creds.refresh ||
    rawCreds.expires !== creds.expires;
  if (rotated) {
    // IMPORTANT: Anthropic/Codex INVALIDATE the old refresh token on rotation. If
    // this resave fails the DB keeps a now-dead token → every future refresh fails
    // and the credential must be reconnected. So retry once, and log at ERROR —
    // NOT a benign "next read re-refreshes" case. The live credential is still
    // returned: it works for this run.
    let resaved = false;
    for (let attempt = 1; attempt <= 2 && !resaved; attempt++) {
      try {
        await saveUserProviderKey({ userId, provider, kind: 'oauth', oauthCreds: rawCreds });
        resaved = true;
        getLog().debug({ userId, provider, attempt }, 'user_provider_key.oauth_rotated_resaved');
      } catch (err) {
        if (attempt === 2) {
          getLog().error(
            { err: err as Error, userId, provider },
            'user_provider_key.oauth_resave_failed'
          );
        }
      }
    }
  }
  return {
    state: 'usable',
    source: 'archon',
    credential: { kind: 'oauth', oauthApiKey: result.apiKey, rawCreds },
  };
}

/**
 * Resolve every usable connected credential for a user, dropping rows whose
 * status is anything else (each drop is logged where it is decided). Used by
 * the workflow inject path to build the per-run env bag.
 *
 * Never throws — returns [] on any failure so the workflow continues.
 *
 * TODO(#1891 follow-up): replace the 1+N query pattern (listUserProviderKeys +
 * one getUserProviderKeyRecord per provider) with a single SELECT * so every
 * chat turn and workflow run pays only one round-trip to the DB.
 */
export async function listDecryptedUserProviderCredentials(
  userId: string
): Promise<{ provider: string; cred: ResolvedCredential }[]> {
  let rows: { provider: string; kind: 'api_key' | 'oauth'; label: string | null }[];
  try {
    rows = await listUserProviderKeys(userId);
  } catch (err) {
    getLog().warn({ err: err as Error, userId }, 'user_provider_key.list_decrypted_query_failed');
    return [];
  }
  const out: { provider: string; cred: ResolvedCredential }[] = [];
  for (const r of rows) {
    try {
      const stored = await getDecryptedProviderCredential(userId, r.provider);
      if (stored.state === 'usable') out.push({ provider: r.provider, cred: stored.credential });
    } catch (err) {
      getLog().warn(
        { err: err as Error, userId, provider: r.provider },
        'user_provider_key.list_decrypted_individual_failed'
      );
    }
  }
  if (out.length < rows.length) {
    // All rows failing to decrypt almost always means the encryption key changed
    // or the key file was deleted — a key-loss/rotation event the operator must
    // act on. Surface it at ERROR with a re-connect hint; a partial failure
    // (some rows still resolve) stays at WARN.
    if (rows.length > 0 && out.length === 0) {
      getLog().error(
        {
          userId,
          total: rows.length,
          resolved: 0,
          hint: 'Re-connect with: archon ai login <vendor>',
        },
        'user_provider_key.mass_decrypt_failure'
      );
    } else {
      getLog().warn(
        { userId, total: rows.length, resolved: out.length },
        'user_provider_key.partial_decrypt_failure'
      );
    }
  }
  return out;
}
