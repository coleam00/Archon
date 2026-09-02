import { mock, describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';
// spyOn (NOT mock.module) for config-loader: this file shares a `bun test`
// invocation with the real config-loader.test.ts, and `mock.module` is
// process-global and irreversible — mocking the loader here would poison it.
import * as configLoader from '../config/config-loader';

const mockQuery = createMockQuery();

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
}));

import {
  getOrCreateConversation,
  updateConversation,
  findConversationByPlatformId,
  listConversations,
  PRIVATE_PLATFORM_TYPES,
  isPrivatePlatformType,
} from './conversations';
import type { Conversation } from '../types';
import { ConversationNotFoundError } from '../types';

describe('conversations', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  describe('getOrCreateConversation', () => {
    const mergedConfig = (assistant: string) =>
      ({ assistant }) as Awaited<ReturnType<typeof configLoader.loadConfig>>;
    let loadConfigSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      loadConfigSpy = spyOn(configLoader, 'loadConfig').mockResolvedValue(mergedConfig('claude'));
    });

    afterEach(() => {
      loadConfigSpy.mockRestore();
    });

    const existingConversation: Conversation = {
      id: 'conv-123',
      platform_type: 'telegram',
      platform_conversation_id: 'chat-456',
      ai_assistant_type: 'claude',
      codebase_id: null,
      cwd: null,
      isolation_env_id: null,
      title: null,
      hidden: false,
      deleted_at: null,
      user_id: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    test('returns existing conversation when found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([existingConversation]));

      const result = await getOrCreateConversation('telegram', 'chat-456');

      expect(result).toEqual(existingConversation);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
        ['telegram', 'chat-456']
      );
    });

    test('creates new conversation with default assistant type', async () => {
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
      };

      // First query returns empty (no existing)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Second query creates new
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('telegram', 'chat-789');

      expect(result).toEqual(newConversation);
      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['telegram', 'chat-789', 'claude', null, null, null]
      );
    });

    test('uses codebase assistant type when codebaseId provided', async () => {
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
        ai_assistant_type: 'codex',
        codebase_id: 'codebase-123',
      };

      // First query returns empty (no existing)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Second query fetches codebase
      mockQuery.mockResolvedValueOnce(createQueryResult([{ ai_assistant_type: 'codex' }]));
      // Third query creates new
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('telegram', 'chat-789', 'codebase-123');

      expect(result).toEqual(newConversation);
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'SELECT ai_assistant_type FROM remote_agent_codebases WHERE id = $1',
        ['codebase-123']
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['telegram', 'chat-789', 'codex', 'codebase-123', null, null]
      );
      // The codebase-level assistant short-circuits the config chain.
      expect(loadConfigSpy).not.toHaveBeenCalled();
    });

    // Harvested from PR #1826 (credit: @EugeneChan00) — the configured default
    // assistant chain (config > DEFAULT_AI_ASSISTANT env > first built-in, all
    // owned by loadConfig) must reach new conversations without a codebase.
    test('resolves the configured default assistant when no codebase is scoped', async () => {
      loadConfigSpy.mockResolvedValueOnce(mergedConfig('codex'));

      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
        ai_assistant_type: 'codex',
      };

      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('web', 'web-new-chat');

      expect(result).toEqual(newConversation);
      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['web', 'web-new-chat', 'codex', null, null, null]
      );
    });

    test('falls back to claude when config load fails', async () => {
      loadConfigSpy.mockRejectedValueOnce(new Error('config unavailable'));

      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
      };

      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('web', 'web-new-chat');

      expect(result).toEqual(newConversation);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['web', 'web-new-chat', 'claude', null, null, null]
      );
    });

    test('falls back to configured default when codebase not found', async () => {
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'conv-new',
      };

      // First query returns empty (no existing)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Second query fetches codebase - not found
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Third query creates new
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation('telegram', 'chat-789', 'non-existent-codebase');

      expect(result).toEqual(newConversation);
      // Missing row → falls through to the config chain.
      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['telegram', 'chat-789', 'claude', 'non-existent-codebase', null, null]
      );
    });

    test('inherits context from parent conversation', async () => {
      const parentConversation: Conversation = {
        ...existingConversation,
        id: 'parent-conv',
        platform_conversation_id: 'parent-channel',
        codebase_id: 'codebase-123',
        cwd: '/workspace/project',
        ai_assistant_type: 'codex',
      };
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'thread-conv',
        platform_conversation_id: 'thread-123',
        codebase_id: 'codebase-123',
        cwd: '/workspace/project',
        ai_assistant_type: 'codex',
      };

      // First query returns empty (no existing thread conversation)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Second query fetches parent conversation
      mockQuery.mockResolvedValueOnce(createQueryResult([parentConversation]));
      // Third query creates new
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation(
        'discord',
        'thread-123',
        undefined,
        'parent-channel'
      );

      expect(result).toEqual(newConversation);
      expect(mockQuery).toHaveBeenCalledTimes(3);
      // Verify parent lookup
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'SELECT * FROM remote_agent_conversations WHERE platform_type = $1 AND platform_conversation_id = $2',
        ['discord', 'parent-channel']
      );
      // Verify inherited values in INSERT
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['discord', 'thread-123', 'codex', 'codebase-123', '/workspace/project', null]
      );
      // Parent inheritance short-circuits the config chain.
      expect(loadConfigSpy).not.toHaveBeenCalled();
    });

    test('does not inherit when parent has no context', async () => {
      const parentConversation: Conversation = {
        ...existingConversation,
        id: 'parent-conv',
        platform_conversation_id: 'parent-channel',
        codebase_id: null,
        cwd: null,
      };
      const newConversation: Conversation = {
        ...existingConversation,
        id: 'thread-conv',
        platform_conversation_id: 'thread-123',
      };

      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([parentConversation]));
      mockQuery.mockResolvedValueOnce(createQueryResult([newConversation]));

      const result = await getOrCreateConversation(
        'discord',
        'thread-123',
        undefined,
        'parent-channel'
      );

      expect(result).toEqual(newConversation);
      // Should use inherited assistant type but null for codebase/cwd
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id, ai_assistant_type, codebase_id, cwd, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['discord', 'thread-123', 'claude', null, null, null]
      );
    });
  });

  describe('findConversationByPlatformId', () => {
    const cliConversation: Conversation = {
      id: 'conv-cli-1',
      platform_type: 'cli',
      platform_conversation_id: 'cli-1234-abc',
      ai_assistant_type: 'claude',
      codebase_id: null,
      cwd: null,
      isolation_env_id: null,
      title: null,
      hidden: false,
      deleted_at: null,
      user_id: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    test('returns conversation when platform_conversation_id matches', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([cliConversation]));

      const result = await findConversationByPlatformId('cli-1234-abc');

      expect(result).toEqual(cliConversation);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_conversations WHERE platform_conversation_id = $1',
        ['cli-1234-abc']
      );
    });

    test('returns null when no conversation matches', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await findConversationByPlatformId('nonexistent');

      expect(result).toBeNull();
    });

    test('works for any platform type without filtering', async () => {
      const telegramConv: Conversation = {
        ...cliConversation,
        id: 'conv-tg-1',
        platform_type: 'telegram',
        platform_conversation_id: 'tg-chat-999',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([telegramConv]));

      const result = await findConversationByPlatformId('tg-chat-999');

      expect(result).toEqual(telegramConv);
      // Verify no platform_type in the query
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_conversations WHERE platform_conversation_id = $1',
        ['tg-chat-999']
      );
    });
  });

  describe('updateConversation', () => {
    test('updates codebase_id only', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateConversation('conv-123', { codebase_id: 'codebase-456' });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_conversations SET codebase_id = $1, updated_at = NOW() WHERE id = $2',
        ['codebase-456', 'conv-123']
      );
    });

    test('updates cwd only', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateConversation('conv-123', { cwd: '/workspace/project' });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_conversations SET cwd = $1, updated_at = NOW() WHERE id = $2',
        ['/workspace/project', 'conv-123']
      );
    });

    test('updates both fields', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateConversation('conv-123', {
        codebase_id: 'codebase-456',
        cwd: '/workspace/project',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_conversations SET codebase_id = $1, cwd = $2, updated_at = NOW() WHERE id = $3',
        ['codebase-456', '/workspace/project', 'conv-123']
      );
    });

    test('does nothing when no updates provided', async () => {
      await updateConversation('conv-123', {});

      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('allows setting codebase_id to null', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateConversation('conv-123', { codebase_id: null });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_conversations SET codebase_id = $1, updated_at = NOW() WHERE id = $2',
        [null, 'conv-123']
      );
    });

    test('throws ConversationNotFoundError when conversation not found (rowCount === 0)', async () => {
      // Simulate UPDATE returning 0 rows affected
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(
        updateConversation('non-existent-id', { codebase_id: 'codebase-456' })
      ).rejects.toThrow(ConversationNotFoundError);

      // Verify the error contains the conversation ID
      try {
        mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
        await updateConversation('test-conv-id', { cwd: '/workspace' });
      } catch (error) {
        expect(error).toBeInstanceOf(ConversationNotFoundError);
        expect((error as ConversationNotFoundError).conversationId).toBe('test-conv-id');
        expect((error as ConversationNotFoundError).message).toBe(
          'Conversation not found: test-conv-id'
        );
      }
    });
  });
  describe('listConversations visibility', () => {
    /** The SQL + params the single mocked pool.query call was issued with. */
    function lastQuery(): { sql: string; params: unknown[] } {
      const call = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
      return { sql: call[0], params: call[1] };
    }

    test("kind 'all' issues no user or platform-privacy clause", async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listConversations(50, undefined, undefined, false, { kind: 'all' });

      const { sql, params } = lastQuery();
      expect(sql).not.toContain('user_id');
      expect(sql).not.toContain('NOT IN');
      expect(params).toEqual([50]);
    });

    test("kind 'ownerScoped' returns the caller's rows plus non-private platforms", async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listConversations(50, undefined, undefined, false, {
        kind: 'ownerScoped',
        userId: 'user-1',
        privatePlatforms: PRIVATE_PLATFORM_TYPES,
      });

      const { sql, params } = lastQuery();
      // One placeholder per platform: neither dialect binds arrays.
      expect(sql).toContain('AND (platform_type NOT IN ($1, $2) OR user_id = $3)');
      expect(params).toEqual(['web', 'cli', 'user-1', 50]);
    });

    test('scoped placeholders stay positional behind the other filters', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listConversations(10, 'web', 'codebase-1', true, {
        kind: 'ownerScoped',
        userId: 'user-1',
        privatePlatforms: PRIVATE_PLATFORM_TYPES,
      });

      const { sql, params } = lastQuery();
      expect(sql).toContain('AND platform_type = $1');
      expect(sql).toContain('AND codebase_id = $2');
      expect(sql).toContain('AND (platform_type NOT IN ($3, $4) OR user_id = $5)');
      expect(sql).toContain('LIMIT $6');
      expect(params).toEqual(['web', 'codebase-1', 'web', 'cli', 'user-1', 10]);
    });

    // Fail-closed: an empty exempt set means NO platform is exempt, so the
    // filter narrows to the caller alone rather than widening to everything.
    test('an empty privatePlatforms list narrows to the caller, never widens', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listConversations(50, undefined, undefined, false, {
        kind: 'ownerScoped',
        userId: 'user-1',
        privatePlatforms: [],
      });

      const { sql, params } = lastQuery();
      expect(sql).toContain('AND user_id = $1');
      expect(sql).not.toContain('NOT IN');
      expect(params).toEqual(['user-1', 50]);
    });
  });

  // The per-row counterpart of the list's `platform_type NOT IN (…)` clause.
  // The by-id authorization check in the server reads this so the two paths
  // cannot disagree about which surfaces privacy covers.
  describe('isPrivatePlatformType', () => {
    test('covers the operator surfaces', () => {
      expect(isPrivatePlatformType('web')).toBe(true);
      expect(isPrivatePlatformType('cli')).toBe(true);
    });

    test('leaves chat and forge platforms to their own access model', () => {
      for (const platform of ['slack', 'discord', 'telegram', 'github', 'gitlab', 'gitea']) {
        expect(isPrivatePlatformType(platform)).toBe(false);
      }
    });

    test('agrees with PRIVATE_PLATFORM_TYPES', () => {
      expect(PRIVATE_PLATFORM_TYPES.every(isPrivatePlatformType)).toBe(true);
    });
  });
});
