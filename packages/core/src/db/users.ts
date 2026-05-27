/**
 * Database operations for users + per-platform user identities.
 *
 * Identity model (PR-A):
 *   remote_agent_users          — Archon-internal identity (one per human/bot)
 *   remote_agent_user_identities — per-platform mapping; UNIQUE(platform, platform_user_id)
 *
 * Identity rows are created lazily on first sight by any chat/forge adapter
 * via findOrCreateUserByPlatformIdentity. Concurrency: two simultaneous
 * first-sight webhooks for the same (platform, platform_user_id) are race-safe
 * — the UNIQUE constraint causes the second writer to throw, and we recover
 * by re-SELECTing the winner's identity row.
 */
import { pool, getDatabase, getDialect } from './connection';
import type { User, UserIdentity } from '../types';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.users');
  return cachedLog;
}

export async function getUserById(id: string): Promise<User | null> {
  const result = await pool.query<User>('SELECT * FROM remote_agent_users WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

async function selectIdentity(
  platform: string,
  platformUserId: string
): Promise<UserIdentity | null> {
  const result = await pool.query<UserIdentity>(
    'SELECT * FROM remote_agent_user_identities WHERE platform = $1 AND platform_user_id = $2',
    [platform, platformUserId]
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve a platform-native user id to an Archon User row, creating the user
 * and the identity mapping if this is the first time we've seen them.
 *
 * Behavior:
 *  - If the identity exists AND the user row exists, return the user. If
 *    `displayName` is provided and the stored values are NULL/empty,
 *    opportunistically backfill them (cheap UX win).
 *  - If the identity exists but the user row is missing (rare orphan case),
 *    repair by re-creating the user and rebinding the identity.
 *  - If the identity does not exist, atomically create both rows in a
 *    transaction. On UNIQUE-constraint race, recover via re-SELECT.
 */
export async function findOrCreateUserByPlatformIdentity(
  platform: string,
  platformUserId: string,
  displayName?: string
): Promise<User> {
  const existing = await selectIdentity(platform, platformUserId);

  if (existing) {
    const user = await getUserById(existing.user_id);
    if (user) {
      if (displayName) {
        await backfillDisplayName(existing, user, displayName);
      }
      return user;
    }
    // Identity points to a user row that was deleted; repair by rebinding.
    getLog().warn(
      { identityId: existing.id, platform, platformUserId },
      'user.identity_orphan_repair_started'
    );
    return await repairOrphanedIdentity(existing.id, platform, platformUserId, displayName);
  }

  const db = getDatabase();
  try {
    return await db.withTransaction(async q => {
      const userResult = await q<User>(
        'INSERT INTO remote_agent_users (display_name) VALUES ($1) RETURNING *',
        [displayName ?? null]
      );
      const user = userResult.rows[0];
      if (!user) {
        throw new Error('users.create_returned_no_row');
      }
      await q<UserIdentity>(
        `INSERT INTO remote_agent_user_identities (user_id, platform, platform_user_id, platform_display_name)
         VALUES ($1, $2, $3, $4)`,
        [user.id, platform, platformUserId, displayName ?? null]
      );
      getLog().info(
        { userId: user.id, platform, platformUserId, displayName },
        'user.create_completed'
      );
      return user;
    });
  } catch (err) {
    // Race recovery: another writer beat us to the same identity. The UNIQUE
    // constraint on (platform, platform_user_id) caused our INSERT to fail and
    // the transaction rolled our user row back. Re-SELECT to find the winner.
    const recovered = await selectIdentity(platform, platformUserId);
    if (recovered) {
      const user = await getUserById(recovered.user_id);
      if (user) {
        getLog().info({ platform, platformUserId, userId: user.id }, 'user.create_race_recovered');
        return user;
      }
    }
    getLog().error({ err, platform, platformUserId }, 'user.create_failed');
    throw err;
  }
}

async function backfillDisplayName(
  identity: UserIdentity,
  user: User,
  displayName: string
): Promise<void> {
  if (!identity.platform_display_name) {
    await pool.query(
      'UPDATE remote_agent_user_identities SET platform_display_name = $1 WHERE id = $2',
      [displayName, identity.id]
    );
  }
  if (!user.display_name) {
    await updateUserDisplayName(user.id, displayName);
  }
}

async function repairOrphanedIdentity(
  identityId: string,
  platform: string,
  platformUserId: string,
  displayName: string | undefined
): Promise<User> {
  const db = getDatabase();
  return await db.withTransaction(async q => {
    const userResult = await q<User>(
      'INSERT INTO remote_agent_users (display_name) VALUES ($1) RETURNING *',
      [displayName ?? null]
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error('users.create_returned_no_row');
    }
    await q(
      'UPDATE remote_agent_user_identities SET user_id = $1, platform_display_name = COALESCE(platform_display_name, $2) WHERE id = $3',
      [user.id, displayName ?? null, identityId]
    );
    getLog().info(
      { userId: user.id, identityId, platform, platformUserId },
      'user.identity_orphan_repair_completed'
    );
    return user;
  });
}

export async function updateUserDisplayName(userId: string, displayName: string): Promise<void> {
  const dialect = getDialect();
  await pool.query(
    `UPDATE remote_agent_users SET display_name = $1, updated_at = ${dialect.now()} WHERE id = $2`,
    [displayName, userId]
  );
}
