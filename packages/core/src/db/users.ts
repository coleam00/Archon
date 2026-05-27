import { pool } from './connection';
import { createLogger } from '@archon/paths';
import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.users');
  return cachedLog;
}

export interface User {
  id: string;
  keycloak_sub: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  github_oauth_token: string | null;
  github_username: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function upsertUser(
  keycloakSub: string,
  email: string | null,
  username: string | null,
  displayName?: string | null
): Promise<User> {
  const result = await pool.query<User>(
    `INSERT INTO remote_agent_users (keycloak_sub, email, username, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (keycloak_sub)
     DO UPDATE SET
       email = EXCLUDED.email,
       username = EXCLUDED.username,
       display_name = COALESCE(EXCLUDED.display_name, remote_agent_users.display_name),
       updated_at = NOW()
     RETURNING *`,
    [keycloakSub, email, username, displayName ?? null]
  );
  const user = result.rows[0];
  if (!user) {
    throw new Error(`upsertUser failed for sub=${keycloakSub}`);
  }
  return user;
}

export async function getUserByKeycloakSub(sub: string): Promise<User | null> {
  const result = await pool.query<User>(
    'SELECT * FROM remote_agent_users WHERE keycloak_sub = $1',
    [sub]
  );
  return result.rows[0] ?? null;
}

export async function getUserById(id: string): Promise<User | null> {
  const result = await pool.query<User>('SELECT * FROM remote_agent_users WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export async function setGithubToken(
  userId: string,
  plainToken: string,
  githubUsername: string
): Promise<void> {
  const key = getEncryptionKey();
  const encrypted = encryptToken(plainToken, key);
  const result = await pool.query(
    `UPDATE remote_agent_users
     SET github_oauth_token = $1, github_username = $2, updated_at = NOW()
     WHERE id = $3`,
    [encrypted, githubUsername, userId]
  );
  if (result.rowCount !== 1) {
    throw new Error(`setGithubToken failed: no user found for id=${userId}`);
  }
  // Don't include githubUsername in the log — treat it as user-identifying data.
  getLog().info({ userId }, 'user.github_token_stored');
}

/**
 * Clear a user's stored GitHub OAuth token and username. Idempotent — safe to
 * call when no token is set.
 */
export async function clearGithubToken(userId: string): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_users
     SET github_oauth_token = NULL, github_username = NULL, updated_at = NOW()
     WHERE id = $1`,
    [userId]
  );
  getLog().info({ userId }, 'user.github_token_cleared');
}

/**
 * Returns the decrypted GitHub OAuth token for a user, or null if not set.
 */
export async function getGithubToken(userId: string): Promise<string | null> {
  const result = await pool.query<{ github_oauth_token: string | null }>(
    'SELECT github_oauth_token FROM remote_agent_users WHERE id = $1',
    [userId]
  );
  const row = result.rows[0];
  if (!row?.github_oauth_token) {
    return null;
  }
  const key = getEncryptionKey();
  return decryptToken(row.github_oauth_token, key);
}
