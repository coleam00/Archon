import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

mock.module('@archon/paths', () => ({
  createLogger: mock(() => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    trace: mock(() => {}),
    fatal: mock(() => {}),
  })),
}));

import {
  getUserAiPrefs,
  setUserTiers,
  setUserAliases,
  setUserDefaultProvider,
  clearUserAiPrefs,
} from './user-ai-prefs-store';

const USER = 'user-1';

function prefsRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    user_id: USER,
    tiers: null,
    aliases: null,
    default_provider: null,
    created_at: '2026-06-11T00:00:00Z',
    updated_at: '2026-06-11T00:00:00Z',
    ...overrides,
  };
}

describe('user-ai-prefs-store', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  describe('getUserAiPrefs', () => {
    test('returns {} when no row exists', async () => {
      const result = await getUserAiPrefs(USER);
      expect(result).toEqual({});
      expect(mockQuery.mock.calls[0][1]).toEqual([USER]);
    });

    test('parses JSON columns and default_provider', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          prefsRow({
            tiers: JSON.stringify({ large: { provider: 'claude', model: 'opus' } }),
            aliases: JSON.stringify({ '@fast': { provider: 'codex', model: 'gpt-5.3-codex' } }),
            default_provider: 'codex',
          }),
        ])
      );
      const result = await getUserAiPrefs(USER);
      expect(result).toEqual({
        tiers: { large: { provider: 'claude', model: 'opus' } },
        aliases: { '@fast': { provider: 'codex', model: 'gpt-5.3-codex' } },
        defaultProvider: 'codex',
      });
    });

    test('omits fields that are NULL', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          prefsRow({ tiers: JSON.stringify({ small: { provider: 'claude', model: 'haiku' } }) }),
        ])
      );
      const result = await getUserAiPrefs(USER);
      expect(result.tiers).toEqual({ small: { provider: 'claude', model: 'haiku' } });
      expect(result.aliases).toBeUndefined();
      expect(result.defaultProvider).toBeUndefined();
    });

    test('treats a corrupt JSON column as unset', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([prefsRow({ tiers: '{not json' })]));
      const result = await getUserAiPrefs(USER);
      expect(result.tiers).toBeUndefined();
    });
  });

  describe('setUserTiers', () => {
    test('merges patch into existing tiers and upserts', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          prefsRow({ tiers: JSON.stringify({ small: { provider: 'claude', model: 'haiku' } }) }),
        ])
      );
      await setUserTiers(USER, { large: { provider: 'claude', model: 'opus' } });
      const [sql, params] = mockQuery.mock.calls[1] as unknown as [string, unknown[]];
      expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE SET tiers');
      expect(params[1]).toBe(USER);
      expect(JSON.parse(params[2] as string)).toEqual({
        small: { provider: 'claude', model: 'haiku' },
        large: { provider: 'claude', model: 'opus' },
      });
    });

    test('null unsets a tier; empty result persists NULL not {}', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          prefsRow({ tiers: JSON.stringify({ large: { provider: 'claude', model: 'opus' } }) }),
        ])
      );
      await setUserTiers(USER, { large: null });
      const [, params] = mockQuery.mock.calls[1] as unknown as [string, unknown[]];
      expect(params[2]).toBeNull();
    });
  });

  describe('setUserAliases', () => {
    test('per-key merge with null-unset', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          prefsRow({
            aliases: JSON.stringify({
              '@fast': { provider: 'codex', model: 'gpt-5.3-codex' },
              '@deep': { provider: 'claude', model: 'opus' },
            }),
          }),
        ])
      );
      await setUserAliases(USER, {
        '@fast': null,
        '@new': { provider: 'pi', model: 'anthropic/claude-haiku-4-5' },
      });
      const [sql, params] = mockQuery.mock.calls[1] as unknown as [string, unknown[]];
      expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE SET aliases');
      expect(JSON.parse(params[2] as string)).toEqual({
        '@deep': { provider: 'claude', model: 'opus' },
        '@new': { provider: 'pi', model: 'anthropic/claude-haiku-4-5' },
      });
    });
  });

  describe('setUserDefaultProvider', () => {
    test('upserts the default_provider column', async () => {
      await setUserDefaultProvider(USER, 'codex');
      const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
      expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE SET default_provider');
      expect(params[1]).toBe(USER);
      expect(params[2]).toBe('codex');
    });

    test('null clears the default', async () => {
      await setUserDefaultProvider(USER, null);
      const [, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
      expect(params[2]).toBeNull();
    });
  });

  describe('clearUserAiPrefs', () => {
    test('deletes the row', async () => {
      await clearUserAiPrefs(USER);
      const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
      expect(sql).toContain('DELETE FROM remote_agent_user_ai_prefs');
      expect(params).toEqual([USER]);
    });
  });
});
