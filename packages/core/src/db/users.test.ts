// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import * as paths from '@archon/paths';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const logger = createMockLogger();
mock.module('@archon/paths', () => ({ ...paths, createLogger: () => logger }));

const mockQuery = createMockQuery();

// withTransaction forwards its callback to the shared mockQuery instance, so
// tests can queue mockResolvedValueOnce in transactional order. To simulate a
// transaction rollback, mockRejectedValueOnce on the INSERT inside the txn —
// the outer try/catch in users.ts decides whether to recover (UNIQUE race) or
// rethrow (any other error).
const mockWithTransaction = mock(
  async (fn: (q: typeof mockQuery) => Promise<unknown>) => await fn(mockQuery)
);

mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
  getDatabase: () => ({ withTransaction: mockWithTransaction }),
}));

import {
  findOrCreateUserByPlatformIdentity,
  getUserById,
  updateUserDisplayName,
  linkGithubIdentity,
  linkPlatformIdentity,
  updateUserGithubProfile,
  GithubIdentityConflictError,
  PlatformIdentityConflictError,
} from './users';
import type { User, UserIdentity } from '../types';

const userRow = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  display_name: null,
  email: null,
  role: 'admin',
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

const identityRow = (overrides: Partial<UserIdentity> = {}): UserIdentity => ({
  id: 'identity-1',
  user_id: 'user-1',
  platform: 'slack',
  platform_user_id: 'U123',
  platform_display_name: null,
  created_at: new Date(),
  ...overrides,
});

describe('users', () => {
  beforeEach(() => {
    logger.debug.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    mockQuery.mockClear();
    mockWithTransaction.mockClear();
  });

  test('invalid platform fails before database access', async () => {
    await expect(findOrCreateUserByPlatformIdentity('invalid_platform', 'user')).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('an identity from an unregistered adapter can be reused', async () => {
    const user = userRow();
    mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ platform: 'matrix-chat' })]));
    mockQuery.mockResolvedValueOnce(createQueryResult([user]));
    expect(await findOrCreateUserByPlatformIdentity('matrix-chat', 'U123')).toEqual(user);
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  describe('getUserById', () => {
    test('returns user when found', async () => {
      const u = userRow();
      mockQuery.mockResolvedValueOnce(createQueryResult([u]));
      const result = await getUserById('user-1');
      expect(result).toEqual(u);
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM remote_agent_users WHERE id = $1', [
        'user-1',
      ]);
    });

    test('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const result = await getUserById('user-missing');
      expect(result).toBeNull();
    });
  });

  describe('findOrCreateUserByPlatformIdentity', () => {
    test('returns existing user when identity row exists', async () => {
      const u = userRow();
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([u]));

      const result = await findOrCreateUserByPlatformIdentity('slack', 'U123');

      expect(result).toEqual(u);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockWithTransaction).not.toHaveBeenCalled();
    });

    test('returns the role from the user row (existing admin)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ role: 'admin' })]));

      const result = await findOrCreateUserByPlatformIdentity('web', 'web-user-1');

      expect(result.role).toBe('admin');
    });

    test('propagates a non-default role from the user row (member round-trip)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ role: 'member' })]));

      const result = await findOrCreateUserByPlatformIdentity('web', 'web-user-2');

      // Confirms the column value is plumbed through, not hardcoded to 'admin'.
      expect(result.role).toBe('member');
    });

    test('backfills both identity and user display_name when both previously null', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'UPDATE remote_agent_user_identities SET platform_display_name = $1 WHERE id = $2',
        ['Alice', 'identity-1']
      );
    });

    test('backfills only user.display_name when identity already has one (asymmetric)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([identityRow({ platform_display_name: 'Stale' })])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ display_name: null })]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      // Identity already has display_name → no identity UPDATE; user row gets the backfill.
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('UPDATE remote_agent_users SET display_name'),
        ['Alice', 'user-1']
      );
    });

    test('does not backfill when both rows already have display_name', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([identityRow({ platform_display_name: 'Existing' })])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ display_name: 'Existing' })]));

      await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('backfill failure does not block user resolution', async () => {
      const u = userRow();
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([u]));
      // Backfill UPDATE on the identity row fails — must be swallowed.
      mockQuery.mockRejectedValueOnce(new Error('connection reset'));

      const result = await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      expect(result).toEqual(u);
    });

    test('creates new user + identity when first seen', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const newUser = userRow({ id: 'user-new', display_name: 'Bob', role: 'member' });
      mockQuery.mockResolvedValueOnce(createQueryResult([newUser]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await findOrCreateUserByPlatformIdentity('telegram', '7654321', 'Bob');

      expect(logger.info).toHaveBeenCalledWith(
        { userId: 'user-new', platform: 'telegram' },
        'user.create_completed'
      );
      expect(logger.debug).toHaveBeenCalledWith({ platform: 'telegram' }, 'user.create_started');
      expect(result).toEqual(newUser);
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_users (display_name, role) VALUES ($1, $2) RETURNING *',
        ['Bob', 'member']
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('INSERT INTO remote_agent_user_identities'),
        ['user-new', 'telegram', '7654321', 'Bob']
      );
    });

    test('creates a new identity for an unregistered adapter', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const newUser = userRow({ id: 'user-new', display_name: 'Bob', role: 'member' });
      mockQuery.mockResolvedValueOnce(createQueryResult([newUser]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await findOrCreateUserByPlatformIdentity('matrix-chat', '7654321', 'Bob');

      expect(result).toEqual(newUser);
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_users (display_name, role) VALUES ($1, $2) RETURNING *',
        ['Bob', 'member']
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('INSERT INTO remote_agent_user_identities'),
        ['user-new', 'matrix-chat', '7654321', 'Bob']
      );
    });

    test('recovers from race on UNIQUE-constraint violation (PG sqlstate 23505)', async () => {
      const winner = userRow({ id: 'user-winner' });
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ id: 'user-loser' })]));
      const pgErr = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
      mockQuery.mockRejectedValueOnce(pgErr);
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ user_id: 'user-winner' })]));
      mockQuery.mockResolvedValueOnce(createQueryResult([winner]));

      const result = await findOrCreateUserByPlatformIdentity('github', 'alice');

      expect(logger.info).toHaveBeenCalledWith(
        { platform: 'github', userId: 'user-winner' },
        'user.create_race_recovered'
      );
      expect(result).toEqual(winner);
    });

    test('recovers from race on UNIQUE-constraint violation (SQLite error message)', async () => {
      const winner = userRow({ id: 'user-winner-sqlite' });
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ id: 'user-loser' })]));
      mockQuery.mockRejectedValueOnce(
        new Error(
          'UNIQUE constraint failed: remote_agent_user_identities.platform, remote_agent_user_identities.platform_user_id'
        )
      );
      mockQuery.mockResolvedValueOnce(
        createQueryResult([identityRow({ user_id: 'user-winner-sqlite' })])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([winner]));

      const result = await findOrCreateUserByPlatformIdentity('discord', '321');

      expect(result).toEqual(winner);
    });

    test('rethrows non-UNIQUE errors WITHOUT attempting race recovery', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      const failure = Object.assign(
        new Error('could not serialize access due to concurrent update'),
        { code: '40001' }
      );
      mockQuery.mockRejectedValueOnce(failure);
      // No re-SELECT should happen — if the narrowed catch is widened by a
      // future refactor, this assertion catches it.

      await expect(findOrCreateUserByPlatformIdentity('slack', 'U999')).rejects.toThrow(
        'could not serialize access'
      );
      // The database error itself is logged, so its message survives for diagnosis.
      expect(logger.error).toHaveBeenCalledWith(
        { err: failure, platform: 'slack' },
        'user.create_failed'
      );
      // Exactly 3 queries: initial identity SELECT + INSERT user + INSERT identity (failed).
      // No recovery SELECT means the narrowed catch path held.
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    test('rethrows when UNIQUE fires but recovery SELECT returns empty', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockRejectedValueOnce(
        Object.assign(new Error('UNIQUE constraint failed'), { code: '23505' })
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(findOrCreateUserByPlatformIdentity('slack', 'U999')).rejects.toThrow(
        'UNIQUE constraint failed'
      );
    });

    test('repairs orphaned identity (user_id points to deleted user)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const repaired = userRow({ id: 'user-repaired', display_name: 'Carol', role: 'member' });
      mockQuery.mockResolvedValueOnce(createQueryResult([repaired]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Carol');

      expect(logger.warn).toHaveBeenCalledWith(
        { identityId: 'identity-1', platform: 'slack' },
        'user.identity_orphan_repair_started'
      );
      expect(logger.info).toHaveBeenCalledWith(
        { userId: 'user-repaired', identityId: 'identity-1', platform: 'slack' },
        'user.identity_orphan_repair_completed'
      );
      expect(result).toEqual(repaired);
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_users (display_name, role) VALUES ($1, $2) RETURNING *',
        ['Carol', 'member']
      );
    });
  });

  describe('updateUserDisplayName', () => {
    test('issues UPDATE with NOW() and provided values', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      await updateUserDisplayName('user-1', 'NewName');
      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_users SET display_name = $1, updated_at = NOW() WHERE id = $2',
        ['NewName', 'user-1']
      );
    });
  });

  describe('linkPlatformIdentity', () => {
    test('invalid platform fails before database access', async () => {
      await expect(linkPlatformIdentity('user-1', 'invalid_platform', 'id')).rejects.toThrow();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('unknown users cannot acquire identities', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      await expect(linkPlatformIdentity('missing', 'matrix', 'id')).rejects.toThrow(
        'Unknown user id: missing'
      );
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('a rejected ownership write reports both users', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ user_id: 'other' })]));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ user_id: 'other' })]));
      await expect(linkPlatformIdentity('user-1', 'slack', 'U123')).rejects.toEqual(
        new PlatformIdentityConflictError('slack', 'U123', 'other', 'user-1')
      );
    });

    test('a GitHub conflict does not carry the login', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ user_id: 'other' })]));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ user_id: 'other' })]));
      const conflict: unknown = await linkGithubIdentity('user-1', 'alice').catch(
        (err: unknown) => err
      );
      expect(conflict).toBeInstanceOf(GithubIdentityConflictError);
      // Callers show and log this error, so it must not carry the login.
      expect(
        JSON.stringify({ ...(conflict as object), message: (conflict as Error).message })
      ).not.toContain('alice');
    });

    test('database failures propagate without recovery', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockRejectedValueOnce(new Error('connection reset'));
      await expect(linkPlatformIdentity('user-1', 'matrix', 'id')).rejects.toThrow(
        'connection reset'
      );
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    test('a disappeared conflict is a failure rather than success', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ user_id: 'other' })]));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      await expect(linkPlatformIdentity('user-1', 'matrix', 'id')).rejects.toThrow(
        'Identity disappeared while linking'
      );
    });

    test('the log names the previous owner only when ownership moved', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ user_id: 'other' })]));
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      await linkPlatformIdentity('user-1', 'slack', 'U123', undefined, true);
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      await linkPlatformIdentity('user-1', 'slack', 'U123', undefined, true);
      expect(logger.info.mock.calls).toEqual([
        [{ userId: 'user-1', platform: 'slack', previousUserId: 'other' }, 'user.identity_linked'],
        [{ userId: 'user-1', platform: 'slack' }, 'user.identity_linked'],
      ]);
    });
  });

  describe('updateUserGithubProfile', () => {
    test('COALESCEs display_name + email and passes [display_name, email, userId]', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      await updateUserGithubProfile('user-1', {
        display_name: 'Alice',
        email: 'alice@example.com',
      });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('COALESCE($1, display_name)');
      expect(sql).toContain('COALESCE($2, email)');
      expect(params).toEqual(['Alice', 'alice@example.com', 'user-1']);
    });

    test('passes null for omitted fields so COALESCE keeps existing values', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      await updateUserGithubProfile('user-1', { email: null });
      expect(mockQuery.mock.calls[0]?.[1]).toEqual([null, null, 'user-1']);
    });
  });
});
