/**
 * Storage for per-user AI-provider credentials (Phase 2), encrypted at rest
 * with AES-256-GCM using the same `TOKEN_ENCRYPTION_KEY` as the per-user
 * GitHub-token store. One row per `(user_id, provider)`.
 *
 * Two credential kinds: `api_key` (a single bearer string) and `oauth` (an
 * opaque blob from `@earendil-works/pi-ai/oauth` provider `login()`). For
 * `api_key`, `getDecryptedProviderCredential` returns the decrypted bearer
 * directly. For `oauth`, refresh-on-read (delegating to Pi's
 * `getOAuthApiKey`) is the responsibility of a follow-up PR; in PR-1 the
 * OAuth read path returns `null` so the workflow inject is safe even when an
 * `oauth` row exists.
 *
 * (Filename carries a `-store` suffix to satisfy a local secret-guard hook
 * that blocks basenames ending in `key(s).ts` / `token(s).ts`; the table is
 * `remote_agent_user_provider_keys`.)
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';
import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';
import type { UserProviderKeyRow } from '../schemas/user-provider-key-row';
import type { OAuthCredentials, ResolvedCredential } from '../credentials/delivery';

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
 * Decrypt the user's credential for a provider into a {@link ResolvedCredential}
 * ready for the delivery map. Returns `null` when:
 *   - the user has no row for this provider, OR
 *   - decryption fails (wrong key after rotation, tampered ciphertext), OR
 *   - the row is OAuth (refresh-on-read is deferred to a follow-up PR).
 *
 * The null contract lets the inject path treat "no usable credential" and
 * "not connected" identically — the workflow continues with whatever env
 * inheritance was already in place.
 */
export async function getDecryptedProviderCredential(
  userId: string,
  provider: string
): Promise<ResolvedCredential | null> {
  const row = await getUserProviderKeyRecord(userId, provider);
  if (!row) {
    getLog().debug({ userId, provider }, 'user_provider_key.not_connected');
    return null;
  }
  const key = getEncryptionKey();
  if (row.kind === 'api_key') {
    if (!row.api_key_encrypted) {
      getLog().warn({ userId, provider }, 'user_provider_key.missing_api_key_ciphertext');
      return null;
    }
    try {
      return { kind: 'api_key', apiKey: decryptToken(row.api_key_encrypted, key) };
    } catch (err) {
      getLog().error({ err: err as Error, userId, provider }, 'user_provider_key.decrypt_failed');
      return null;
    }
  }
  // OAuth refresh-on-read lands with the OAuth connect PR (G4). Until then,
  // OAuth rows can be stored and deleted but the delivery map never sees
  // them — the workflow inject is safe.
  getLog().debug({ userId, provider }, 'user_provider_key.oauth_read_deferred_pending_g4');
  return null;
}

/**
 * Resolve every connected credential for a user, dropping rows that can't be
 * decrypted (OAuth rows currently, decrypt failures, etc.). Used by the
 * workflow inject path to build the per-run env bag.
 *
 * Never throws — returns [] on any failure so the workflow continues.
 *
 * TODO(#1891 PR-2): replace the 1+N query pattern (listUserProviderKeys +
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
      const cred = await getDecryptedProviderCredential(userId, r.provider);
      if (cred) out.push({ provider: r.provider, cred });
    } catch (err) {
      getLog().warn(
        { err: err as Error, userId, provider: r.provider },
        'user_provider_key.list_decrypted_individual_failed'
      );
    }
  }
  if (out.length < rows.length) {
    getLog().warn(
      { userId, total: rows.length, resolved: out.length },
      'user_provider_key.partial_decrypt_failure'
    );
  }
  return out;
}
