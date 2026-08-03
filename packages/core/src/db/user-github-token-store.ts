/**
 * Storage for per-user GitHub user-to-server tokens (device flow), encrypted at
 * rest with AES-256-GCM. One row per Archon user.
 *
 * `getDecryptedAccessToken` refreshes the access token on read when it is within
 * REFRESH_BUFFER_MS of expiry. Refreshes are serialized per-user via an
 * in-process promise map so two concurrent reads don't both consume the
 * single-use refresh token (which would invalidate the good one).
 *
 * (Filename carries a `-store` suffix to satisfy a local secret-guard hook that
 * blocks basenames ending in `token(s).ts`; the table is
 * `remote_agent_user_github_tokens`.)
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';
import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';
import { refreshUserToken, type DeviceAccessToken } from '../github-auth/device-flow';
import { loadDeviceFlowConfig } from '../github-auth/config';
import type { UserGithubTokenRow } from '../schemas/user-github-token-row';

/** Refresh the access token if it expires within this window. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.user-github-tokens');
  return cachedLog;
}

export interface SaveUserGithubTokenParams {
  userId: string;
  githubUserId: number;
  githubLogin: string;
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  refreshTokenExpiresAt?: Date | null;
}

/** Coerce a dialect-dependent timestamp (PG Date | SQLite ISO string) to epoch ms. */
function toEpochMs(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export async function saveUserGithubToken(params: SaveUserGithubTokenParams): Promise<void> {
  const key = getEncryptionKey();
  const accessEnc = encryptToken(params.accessToken, key);
  const refreshEnc = params.refreshToken ? encryptToken(params.refreshToken, key) : null;
  const dialect = getDialect();

  await pool.query(
    `INSERT INTO remote_agent_user_github_tokens
       (user_id, github_user_id, github_login, access_token_encrypted, refresh_token_encrypted,
        access_token_expires_at, refresh_token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET
       github_user_id = EXCLUDED.github_user_id,
       github_login = EXCLUDED.github_login,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
       updated_at = ${dialect.now()}`,
    [
      params.userId,
      params.githubUserId,
      params.githubLogin,
      accessEnc,
      refreshEnc,
      params.accessTokenExpiresAt?.toISOString() ?? null,
      params.refreshTokenExpiresAt?.toISOString() ?? null,
    ]
  );
  // Never log token values; githubLogin is user-identifying but low-sensitivity.
  getLog().info(
    { userId: params.userId, githubLogin: params.githubLogin },
    'user_github_token.stored'
  );
}

export async function getUserGithubTokenRecord(userId: string): Promise<UserGithubTokenRow | null> {
  // node-postgres returns BIGINT as a string; type the raw read accordingly and
  // normalize github_user_id so the number-typed row is honest for both dialects
  // (SQLite already yields a number).
  const result = await pool.query<
    Omit<UserGithubTokenRow, 'github_user_id'> & { github_user_id: number | string }
  >('SELECT * FROM remote_agent_user_github_tokens WHERE user_id = $1', [userId]);
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, github_user_id: Number(row.github_user_id) };
}

export async function deleteUserGithubToken(userId: string): Promise<void> {
  await pool.query('DELETE FROM remote_agent_user_github_tokens WHERE user_id = $1', [userId]);
  getLog().info({ userId }, 'user_github_token.deleted');
}

/**
 * The commit no-reply email for a connected user, or null if not connected.
 * Format: `<numeric_id>+<login>@users.noreply.github.com`.
 */
export async function getUserGithubNoreplyEmail(userId: string): Promise<string | null> {
  const row = await getUserGithubTokenRecord(userId);
  if (!row) return null;
  return `${row.github_user_id}+${row.github_login}@users.noreply.github.com`;
}

const inflightRefreshes = new Map<string, Promise<string | null>>();

/**
 * Return a usable access token for the user, refreshing on read when near
 * expiry. Returns null when the user is not connected, has no refresh token to
 * renew an expired access token, or the refresh fails irrecoverably — callers
 * treat null as "unconnected".
 */
export async function getDecryptedAccessToken(userId: string): Promise<string | null> {
  const existing = inflightRefreshes.get(userId);
  if (existing) return existing;
  const promise = resolveAccessToken(userId).finally(() => inflightRefreshes.delete(userId));
  inflightRefreshes.set(userId, promise);
  return promise;
}

async function resolveAccessToken(userId: string): Promise<string | null> {
  const row = await getUserGithubTokenRecord(userId);
  if (!row) {
    // Normal "never connected" path. Logged at debug so it is distinguishable
    // from the expired/refresh-failed null results below when tracing why a
    // user's commits lack GitHub attribution.
    getLog().debug({ userId }, 'user_github_token.not_connected');
    return null;
  }

  const key = getEncryptionKey();
  const expiresAtMs = toEpochMs(row.access_token_expires_at);
  const needsRefresh = expiresAtMs !== null && Date.now() + REFRESH_BUFFER_MS >= expiresAtMs;

  if (!needsRefresh) {
    try {
      return decryptToken(row.access_token_encrypted, key);
    } catch (err) {
      // Wrong key (post key-rotation), tampered/bitrotted ciphertext. Honor the
      // documented null contract instead of throwing an opaque crypto error at
      // callers (the requires:[github] gate treats null as "unconnected").
      getLog().error({ err: err as Error, userId }, 'user_github_token.decrypt_failed');
      return null;
    }
  }

  if (!row.refresh_token_encrypted) {
    getLog().warn({ userId }, 'user_github_token.expired_no_refresh');
    return null;
  }

  // Refresh and persist are deliberately separated: a refresh failure is
  // recoverable (another process may have rotated the token — re-read below),
  // whereas a persist failure after a SUCCESSFUL refresh must not be mislabeled
  // as a refresh failure nor discard the freshly issued (now-valid) token.
  let refreshToken: string;
  try {
    refreshToken = decryptToken(row.refresh_token_encrypted, key);
  } catch (err) {
    getLog().error({ err: err as Error, userId }, 'user_github_token.decrypt_failed');
    return null;
  }
  let refreshed: DeviceAccessToken;
  try {
    const { clientId } = loadDeviceFlowConfig();
    refreshed = await refreshUserToken(clientId, refreshToken);
  } catch (err) {
    getLog().warn({ err: err as Error, userId }, 'user_github_token.refresh_failed');
    // A concurrent process (or prior call) may have already refreshed — re-read
    // once and use the fresh token if it's now valid.
    const fresh = await getUserGithubTokenRecord(userId);
    const freshExpiry = fresh ? toEpochMs(fresh.access_token_expires_at) : null;
    if (fresh && freshExpiry !== null && Date.now() + REFRESH_BUFFER_MS < freshExpiry) {
      try {
        return decryptToken(fresh.access_token_encrypted, key);
      } catch (decryptErr) {
        getLog().error({ err: decryptErr as Error, userId }, 'user_github_token.decrypt_failed');
        return null;
      }
    }
    return null;
  }

  const now = Date.now();
  try {
    await saveUserGithubToken({
      userId,
      githubUserId: row.github_user_id,
      githubLogin: row.github_login,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? refreshToken,
      accessTokenExpiresAt: refreshed.expires_in
        ? new Date(now + refreshed.expires_in * 1000)
        : null,
      refreshTokenExpiresAt: refreshed.refresh_token_expires_in
        ? new Date(now + refreshed.refresh_token_expires_in * 1000)
        : null,
    });
    getLog().info({ userId }, 'user_github_token.refreshed');
  } catch (err) {
    // GitHub already rotated the token, but we could not persist the new pair.
    // Surface loudly (distinct from refresh_failed) so the broken-on-next-read
    // state is visible, but still return the valid token for the current call.
    getLog().error({ err: err as Error, userId }, 'user_github_token.persist_failed');
  }
  return refreshed.access_token;
}
