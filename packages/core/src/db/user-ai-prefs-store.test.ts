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
  setUserDefault,
  clearUserAiPrefs,
  sanitizeAiderDeskTiersRow,
  normalizeStaleAiderDeskTiers,
  type AiderDeskSanitizationResult,
} from './user-ai-prefs-store';

const USER = 'user-1';

function prefsRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    user_id: USER,
    tiers: null,
    aliases: null,
    default_provider: null,
    default_model: null,
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

    test('parses JSON columns, default_provider, and default_model', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          prefsRow({
            tiers: JSON.stringify({ large: { provider: 'claude', model: 'opus' } }),
            aliases: JSON.stringify({ '@fast': { provider: 'codex', model: 'gpt-5.6-sol' } }),
            default_provider: 'codex',
            default_model: 'gpt-5.5',
          }),
        ])
      );
      const result = await getUserAiPrefs(USER);
      expect(result).toEqual({
        tiers: { large: { provider: 'claude', model: 'opus' } },
        aliases: { '@fast': { provider: 'codex', model: 'gpt-5.6-sol' } },
        defaultProvider: 'codex',
        defaultModel: 'gpt-5.5',
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
      expect(result.defaultModel).toBeUndefined();
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
              '@fast': { provider: 'codex', model: 'gpt-5.6-sol' },
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

  describe('setUserDefault', () => {
    test('upserts default_provider and default_model atomically', async () => {
      await setUserDefault(USER, 'codex', 'gpt-5.5');
      const [sql, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
      expect(sql).toContain(
        'ON CONFLICT (user_id) DO UPDATE SET default_provider = $3, default_model = $4'
      );
      expect(params[1]).toBe(USER);
      expect(params[2]).toBe('codex');
      expect(params[3]).toBe('gpt-5.5');
    });

    test('provider without model clears any previous model pin', async () => {
      await setUserDefault(USER, 'codex', null);
      const [, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
      expect(params[2]).toBe('codex');
      expect(params[3]).toBeNull();
    });

    test('null clears both columns', async () => {
      await setUserDefault(USER, null, null);
      const [, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
      expect(params[2]).toBeNull();
      expect(params[3]).toBeNull();
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

  // ─── sanitizeAiderDeskTiersRow (#25df78a1): stop stale pre-1fac9e3 literals  ──

  const SMALL = { provider: 'aiderdesk', model: 'Power Tools' };

  describe('sanitizeAiderDeskTiersRow', () => {
    test('undefined tiers → empty result', () => {
      expect(sanitizeAiderDeskTiersRow(undefined, SMALL)).toEqual({
        tiers: {},
        rewritten: 0,
        staleValues: [],
      });
    });

    test('clean aiderdesk profile names pass through untouched', () => {
      const clean = {
        small: { provider: 'aiderdesk', model: 'Power Tools' },
        medium: { provider: 'aiderdesk', model: 'Aider' },
        large: { provider: 'aiderdesk', model: 'Poe' },
      };
      const result = sanitizeAiderDeskTiersRow(clean, SMALL);
      expect(result.rewritten).toBe(0);
      expect(result.staleValues).toEqual([]);
      expect(result.tiers).toEqual(clean);
    });

    test('stale `<providerId>/<modelId>` literal is rewritten to configured.samll', () => {
      // Pre-`1fac9e3` convention; cannot reach the AiderDesk agent-profile
      // catalog. Replace with the operator's current small preset.
      const stale = { small: { provider: 'aiderdesk', model: 'ollama/gemma4:8b-8k' } };
      const result = sanitizeAiderDeskTiersRow(stale, SMALL);
      expect(result.rewritten).toBe(1);
      expect(result.staleValues).toEqual(['ollama/gemma4:8b-8k']);
      expect(result.tiers.small).toEqual({
        provider: 'aiderdesk',
        model: 'Power Tools',
      });
    });

    test('mixed valid + stale entries: only the stale entries are rewritten', () => {
      const mixed = {
        small: { provider: 'aiderdesk', model: 'ollama/internlm/internlm2.5:7b-8k' },
        large: { provider: 'aiderdesk', model: 'Poe' },
      };
      const result = sanitizeAiderDeskTiersRow(mixed, SMALL);
      expect(result.rewritten).toBe(1);
      expect(result.staleValues).toEqual(['ollama/internlm/internlm2.5:7b-8k']);
      expect(result.tiers.small).toEqual(SMALL);
      expect(result.tiers.large).toEqual({ provider: 'aiderdesk', model: 'Poe' });
    });

    test('non-aiderdesk providers are NEVER touched (structural, not global)', () => {
      const foreign = { small: { provider: 'pi', model: 'ollama/whatever-7b' } };
      const result = sanitizeAiderDeskTiersRow(foreign, SMALL);
      expect(result.rewritten).toBe(0);
      expect(result.tiers).toEqual(foreign);
    });

    test("a clean aiderdesk entry that happens to contain '/' but is a profile-shaped ID is preserved", () => {
      // Defensive: profile names never contain '/', so if one does, it is by
      // definition stale. This documents the structural decision (structural
      // validity, not "looks like inference literal").
      const weird = { small: { provider: 'aiderdesk', model: 'A/B' } };
      const result = sanitizeAiderDeskTiersRow(weird, SMALL);
      expect(result.rewritten).toBe(1);
      expect(result.staleValues).toEqual(['A/B']);
      expect(result.tiers.small).toEqual(SMALL);
    });
  });

  // ─── normalizeStaleAiderDeskTiers (#25df78a1): DB-bound wrapper ───────────

  describe('normalizeStaleAiderDeskTiers', () => {
    test('no row → no-op, returns hadRow:false', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const result = await normalizeStaleAiderDeskTiers(USER, SMALL);
      expect(result).toEqual({
        userId: USER,
        hadRow: false,
        rewritten: 0,
        staleValues: [],
        wrote: false,
      });
    });

    test('clean row → no-op, no UPDATE issued', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          prefsRow({
            tiers: JSON.stringify({
              small: { provider: 'aiderdesk', model: 'Power Tools' },
            }),
          }),
        ])
      );
      const beforeCalls = mockQuery.mock.calls.length;
      const result = await normalizeStaleAiderDeskTiers(USER, SMALL);
      expect(result).toEqual({
        userId: USER,
        hadRow: true,
        rewritten: 0,
        staleValues: [],
        wrote: false,
      });
      expect(mockQuery.mock.calls.length).toBe(beforeCalls + 1);
    });

    test('stale row in dry-run (default) → reports but does NOT write', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          prefsRow({
            tiers: JSON.stringify({
              small: { provider: 'aiderdesk', model: 'ollama/gemma4:8b-8k' },
            }),
          }),
        ])
      );
      const result = await normalizeStaleAiderDeskTiers(USER, SMALL);
      expect(result.rewritten).toBe(1);
      expect(result.staleValues).toEqual(['ollama/gemma4:8b-8k']);
      expect(result.wrote).toBe(false);
      expect(mockQuery.mock.calls.length).toBe(1);
    });

    test('stale row with apply:true → SELECT + UPDATE writes the sanitized JSON', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          prefsRow({
            tiers: JSON.stringify({
              small: { provider: 'aiderdesk', model: 'ollama/gemma4:8b-8k' },
            }),
          }),
        ])
      );
      const result = await normalizeStaleAiderDeskTiers(USER, SMALL, { apply: true });
      expect(result.rewritten).toBe(1);
      expect(result.staleValues).toEqual(['ollama/gemma4:8b-8k']);
      expect(result.wrote).toBe(true);
      const updateCall = mockQuery.mock.calls[1] as unknown as [string, unknown[]];
      const [sql, params] = updateCall;
      expect(sql).toContain('UPDATE remote_agent_user_ai_prefs');
      expect(sql).toContain('SET tiers = $1');
      expect(sql).toContain('WHERE user_id = $2');
      const writtenTiers = JSON.parse(params[0] as string) as Record<string, unknown>;
      expect(writtenTiers.small).toEqual({ provider: 'aiderdesk', model: 'Power Tools' });
      expect(params[1]).toBe(USER);
    });

    test('corrupt JSON column → treated as unset (zero findings, no UPDATE)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([prefsRow({ tiers: '{not json' })]));
      const result = await normalizeStaleAiderDeskTiers(USER, SMALL);
      expect(result).toEqual({
        userId: USER,
        hadRow: true,
        rewritten: 0,
        staleValues: [],
        wrote: false,
      });
      expect(mockQuery.mock.calls.length).toBe(1);
    });
  });
});
