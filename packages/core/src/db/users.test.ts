import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// withTransaction simply forwards its callback to the mockQuery shared instance,
// so tests can queue mockResolvedValueOnce in transactional order. Tests that
// want to simulate a transaction rollback can mockRejectedValueOnce on the
// INSERT inside the txn — the outer try/catch in users.ts will fall through
// to the race-recovery path.
const mockWithTransaction = mock(
  async (fn: (q: typeof mockQuery) => Promise<unknown>) => await fn(mockQuery)
);

mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
  getDatabase: () => ({ withTransaction: mockWithTransaction }),
}));

import { findOrCreateUserByPlatformIdentity, getUserById, updateUserDisplayName } from './users';
import type { User, UserIdentity } from '../types';

const userRow = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  display_name: null,
  email: null,
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
    mockQuery.mockClear();
    mockWithTransaction.mockClear();
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
      // 1) SELECT identity → found
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      // 2) SELECT user → found
      mockQuery.mockResolvedValueOnce(createQueryResult([u]));

      const result = await findOrCreateUserByPlatformIdentity('slack', 'U123');

      expect(result).toEqual(u);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      // No transaction needed on the fast path
      expect(mockWithTransaction).not.toHaveBeenCalled();
    });

    test('backfills display_name on existing identity when previously null', async () => {
      // 1) SELECT identity (no display_name)
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      // 2) SELECT user (no display_name)
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      // 3) UPDATE identity.platform_display_name
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // 4) UPDATE user.display_name
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'UPDATE remote_agent_user_identities SET platform_display_name = $1 WHERE id = $2',
        ['Alice', 'identity-1']
      );
    });

    test('does not backfill when displayName already present', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([identityRow({ platform_display_name: 'Existing' })])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ display_name: 'Existing' })]));

      await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Alice');

      // Only the two SELECTs — no UPDATEs
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('creates new user + identity when first seen', async () => {
      // 1) SELECT identity → empty
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // 2) (inside txn) INSERT user → returns row
      const newUser = userRow({ id: 'user-new', display_name: 'Bob' });
      mockQuery.mockResolvedValueOnce(createQueryResult([newUser]));
      // 3) (inside txn) INSERT identity
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await findOrCreateUserByPlatformIdentity('telegram', '7654321', 'Bob');

      expect(result).toEqual(newUser);
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_users (display_name) VALUES ($1) RETURNING *',
        ['Bob']
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('INSERT INTO remote_agent_user_identities'),
        ['user-new', 'telegram', '7654321', 'Bob']
      );
    });

    test('recovers from race when UNIQUE constraint fires after losing write', async () => {
      const winner = userRow({ id: 'user-winner' });
      // 1) SELECT identity (initial) → empty
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // 2) (inside txn) INSERT user → returns row
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow({ id: 'user-loser' })]));
      // 3) (inside txn) INSERT identity → race: UNIQUE constraint fires
      mockQuery.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
      // 4) After catch: re-SELECT identity → winner's row
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow({ user_id: 'user-winner' })]));
      // 5) SELECT user (winner) → found
      mockQuery.mockResolvedValueOnce(createQueryResult([winner]));

      const result = await findOrCreateUserByPlatformIdentity('github', 'alice');

      expect(result).toEqual(winner);
    });

    test('rethrows when error is not a race (no identity row exists after failure)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([userRow()]));
      mockQuery.mockRejectedValueOnce(new Error('serialization failure'));
      // No identity row appears in recovery SELECT
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(findOrCreateUserByPlatformIdentity('slack', 'U999')).rejects.toThrow(
        'serialization failure'
      );
    });

    test('repairs orphaned identity (user_id points to deleted user)', async () => {
      // 1) SELECT identity (exists)
      mockQuery.mockResolvedValueOnce(createQueryResult([identityRow()]));
      // 2) SELECT user → null (orphan)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // 3) (inside txn) INSERT user (repair) → new user
      const repaired = userRow({ id: 'user-repaired', display_name: 'Carol' });
      mockQuery.mockResolvedValueOnce(createQueryResult([repaired]));
      // 4) (inside txn) UPDATE identity → rebind
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await findOrCreateUserByPlatformIdentity('slack', 'U123', 'Carol');

      expect(result).toEqual(repaired);
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
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
});
