import { mock, describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { join } from 'path';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import { Codebase } from '../types';
// spyOn (NOT mock.module) for config-loader: avoids poisoning config-loader.test.ts
// in the same bun test invocation (pattern: conversations.test.ts).
import * as configLoader from '../config/config-loader';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
}));

import {
  createCodebase,
  getCodebase,
  updateCodebaseCommands,
  getCodebaseCommands,
  registerCommand,
  findCodebaseByRepoUrl,
  findCodebaseByDefaultCwd,
  findCodebaseByPathPrefix,
  findCodebaseByName,
  updateCodebase,
  deleteCodebase,
  CodebaseNotFoundError,
} from './codebases';

describe('codebases', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const mockCodebase: Codebase = {
    id: 'codebase-123',
    name: 'test-project',
    repository_url: 'https://github.com/user/repo',
    default_cwd: '/workspace/test-project',
    default_branch: 'main',
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: { plan: { path: '.claude/commands/plan.md', description: 'Plan feature' } },
    created_at: new Date(),
    updated_at: new Date(),
  };

  describe('createCodebase', () => {
    // Default spy: loadConfig resolves to 'claude' unless overridden per-test
    let loadConfigSpy: ReturnType<typeof spyOn>;
    beforeEach(() => {
      loadConfigSpy = spyOn(configLoader, 'loadConfig').mockResolvedValue({
        assistant: 'claude',
      } as Awaited<ReturnType<typeof configLoader.loadConfig>>);
    });
    afterEach(() => {
      loadConfigSpy.mockRestore();
    });

    test('creates codebase with all fields', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockCodebase]));

      const result = await createCodebase({
        name: 'test-project',
        repository_url: 'https://github.com/user/repo',
        default_cwd: '/workspace/test-project',
        default_branch: 'main',
        ai_assistant_type: 'claude',
      });

      expect(result).toEqual(mockCodebase);
      expect(mockQuery).toHaveBeenCalledWith(
        'INSERT INTO remote_agent_codebases (name, repository_url, default_cwd, default_branch, ai_assistant_type, kind) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [
          'test-project',
          'https://github.com/user/repo',
          '/workspace/test-project',
          'main',
          'claude',
          'repo',
        ]
      );
    });

    test('creates codebase with optional fields omitted', async () => {
      const codebaseWithoutOptional: Codebase = {
        ...mockCodebase,
        repository_url: null,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([codebaseWithoutOptional]));

      const result = await createCodebase({
        name: 'test-project',
        default_cwd: '/workspace/test-project',
      });

      expect(result).toEqual(codebaseWithoutOptional);
      expect(mockQuery).toHaveBeenCalledWith(
        'INSERT INTO remote_agent_codebases (name, repository_url, default_cwd, default_branch, ai_assistant_type, kind) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        ['test-project', null, '/workspace/test-project', null, 'claude', 'repo']
      );
    });

    test('resolves default assistant from loadConfig when ai_assistant_type omitted', async () => {
      loadConfigSpy.mockResolvedValue({ assistant: 'codex' } as Awaited<
        ReturnType<typeof configLoader.loadConfig>
      >);
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockCodebase, ai_assistant_type: 'codex' }])
      );

      await createCodebase({
        name: 'test-project',
        default_cwd: '/workspace/test-project',
      });

      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(loadConfigSpy).toHaveBeenCalledWith('/workspace/test-project');
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['codex']));
    });

    test('resolves default assistant from loadConfig when ai_assistant_type is null', async () => {
      loadConfigSpy.mockResolvedValue({ assistant: 'codex' } as Awaited<
        ReturnType<typeof configLoader.loadConfig>
      >);
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockCodebase, ai_assistant_type: 'codex' }])
      );

      await createCodebase({
        name: 'test-project',
        default_cwd: '/workspace/test-project',
        ai_assistant_type: null as unknown as undefined,
      });

      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(loadConfigSpy).toHaveBeenCalledWith('/workspace/test-project');
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['codex']));
    });

    test('falls back to claude when loadConfig throws', async () => {
      loadConfigSpy.mockRejectedValue(new Error('config load failed'));
      mockQuery.mockResolvedValueOnce(createQueryResult([mockCodebase]));

      await createCodebase({
        name: 'test-project',
        default_cwd: '/workspace/test-project',
      });

      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['claude'])
      );
    });

    test('explicit ai_assistant_type bypasses loadConfig', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockCodebase, ai_assistant_type: 'pi' }])
      );

      await createCodebase({
        name: 'test-project',
        default_cwd: '/workspace/test-project',
        ai_assistant_type: 'pi',
      });

      expect(loadConfigSpy).not.toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['pi']));
    });
  });

  describe('getCodebase', () => {
    test('returns existing codebase', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockCodebase]));

      const result = await getCodebase('codebase-123');

      expect(result).toEqual(mockCodebase);
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM remote_agent_codebases WHERE id = $1', [
        'codebase-123',
      ]);
    });

    test('returns null for non-existent codebase', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getCodebase('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('findCodebaseByPathPrefix', () => {
    // Build fixture paths with join() so they use the platform separator —
    // stored default_cwd values come from resolve()/realpath() and are always
    // platform-native, and the implementation compares against path.sep.
    // Hardcoded POSIX literals fail the boundary check on Windows.
    const P = (...segments: string[]): string => join('/x', ...segments);
    const rows = [
      { ...mockCodebase, id: 'plat', default_cwd: P('platform') },
      { ...mockCodebase, id: 'stag', default_cwd: P('platform-staging') },
      { ...mockCodebase, id: 'under', default_cwd: P('my_app') },
      { ...mockCodebase, id: 'svc', default_cwd: P('platform', 'svc-a') },
    ];

    test('matches an exact default_cwd', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult(rows));
      const result = await findCodebaseByPathPrefix(P('platform'));
      expect(result?.id).toBe('plat');
    });

    test('matches an ancestor directory on a separator boundary', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult(rows));
      // …/platform/svc-a/deep → most-specific ancestor is the svc-a row
      const result = await findCodebaseByPathPrefix(P('platform', 'svc-a', 'deep'));
      expect(result?.id).toBe('svc');
    });

    test('does NOT match a sibling that merely shares a name prefix', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult(rows));
      // …/platform-staging must NOT resolve to …/platform (the old LIKE bug)
      const result = await findCodebaseByPathPrefix(P('platform-staging'));
      expect(result?.id).toBe('stag');
    });

    test('does NOT treat an underscore in default_cwd as a wildcard', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult(rows));
      // …/myXapp would match …/my_app under SQL LIKE (_ = any char); it must not.
      const result = await findCodebaseByPathPrefix(P('myXapp'));
      expect(result).toBeNull();
    });

    test('returns null when no codebase is an ancestor', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult(rows));
      const result = await findCodebaseByPathPrefix(join('/y', 'unrelated'));
      expect(result).toBeNull();
    });

    test('queries all rows without an unescaped LIKE', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      await findCodebaseByPathPrefix('/x/platform');
      const sql = (mockQuery.mock.calls[0]?.[0] ?? '') as string;
      expect(sql).not.toContain('LIKE');
    });
  });

  describe('updateCodebaseCommands', () => {
    test('serializes commands to JSON', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const commands = {
        plan: { path: '.claude/commands/plan.md', description: 'Plan feature' },
        execute: { path: '.claude/commands/execute.md', description: 'Execute plan' },
      };

      await updateCodebaseCommands('codebase-123', commands);

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_codebases SET commands = $1, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(commands), 'codebase-123']
      );
    });

    test('handles empty commands object', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateCodebaseCommands('codebase-123', {});

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_codebases SET commands = $1, updated_at = NOW() WHERE id = $2',
        ['{}', 'codebase-123']
      );
    });
  });

  describe('getCodebaseCommands', () => {
    test('deserializes commands from JSON', async () => {
      const commands = {
        plan: { path: '.claude/commands/plan.md', description: 'Plan feature' },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([{ commands }]));

      const result = await getCodebaseCommands('codebase-123');

      expect(result).toEqual(commands);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT commands FROM remote_agent_codebases WHERE id = $1',
        ['codebase-123']
      );
    });

    test('returns empty object for non-existent codebase', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getCodebaseCommands('non-existent');

      expect(result).toEqual({});
    });

    test('returns empty object when commands is null', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ commands: null }]));

      const result = await getCodebaseCommands('codebase-123');

      expect(result).toEqual({});
    });

    test('returns mutable object even when source is frozen (SQLite behavior)', async () => {
      const frozenCommands = Object.freeze({
        plan: { path: '.archon/commands/plan.md', description: 'Plan feature' },
      });
      mockQuery.mockResolvedValueOnce(createQueryResult([{ commands: frozenCommands }]));

      const commands = await getCodebaseCommands('codebase-123');

      // Must not throw - result should be a mutable copy
      commands['new-command'] = { path: 'test.md', description: 'Test' };
      expect(commands['new-command']).toEqual({ path: 'test.md', description: 'Test' });
      // Original frozen object should be unchanged
      expect(frozenCommands).not.toHaveProperty('new-command');
    });

    test('throws on corrupt JSON string (SQLite TEXT column)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ commands: '{not valid json' }]));

      await expect(getCodebaseCommands('codebase-123')).rejects.toThrow(
        /Corrupt commands JSON for codebase codebase-123/
      );
    });

    test('parses valid JSON string from SQLite TEXT column', async () => {
      const commands = { plan: { path: 'plan.md', description: 'Plan' } };
      mockQuery.mockResolvedValueOnce(createQueryResult([{ commands: JSON.stringify(commands) }]));

      const result = await getCodebaseCommands('codebase-123');
      expect(result).toEqual(commands);
    });
  });

  describe('registerCommand', () => {
    test('adds new command', async () => {
      // First call: getCodebaseCommands
      mockQuery.mockResolvedValueOnce(createQueryResult([{ commands: {} }]));
      // Second call: updateCodebaseCommands
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await registerCommand('codebase-123', 'plan', {
        path: '.claude/commands/plan.md',
        description: 'Plan feature',
      });

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'UPDATE remote_agent_codebases SET commands = $1, updated_at = NOW() WHERE id = $2',
        [
          JSON.stringify({
            plan: { path: '.claude/commands/plan.md', description: 'Plan feature' },
          }),
          'codebase-123',
        ]
      );
    });

    test('overwrites existing command', async () => {
      const existingCommands = {
        plan: { path: '.claude/commands/old-plan.md', description: 'Old plan' },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([{ commands: existingCommands }]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await registerCommand('codebase-123', 'plan', {
        path: '.claude/commands/new-plan.md',
        description: 'New plan',
      });

      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'UPDATE remote_agent_codebases SET commands = $1, updated_at = NOW() WHERE id = $2',
        [
          JSON.stringify({
            plan: { path: '.claude/commands/new-plan.md', description: 'New plan' },
          }),
          'codebase-123',
        ]
      );
    });

    test('preserves other commands when adding new one', async () => {
      const existingCommands = {
        execute: { path: '.claude/commands/execute.md', description: 'Execute plan' },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([{ commands: existingCommands }]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await registerCommand('codebase-123', 'plan', {
        path: '.claude/commands/plan.md',
        description: 'Plan feature',
      });

      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'UPDATE remote_agent_codebases SET commands = $1, updated_at = NOW() WHERE id = $2',
        [
          JSON.stringify({
            execute: { path: '.claude/commands/execute.md', description: 'Execute plan' },
            plan: { path: '.claude/commands/plan.md', description: 'Plan feature' },
          }),
          'codebase-123',
        ]
      );
    });
  });

  describe('findCodebaseByRepoUrl', () => {
    test('finds matching codebase', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockCodebase]));

      const result = await findCodebaseByRepoUrl('https://github.com/user/repo');

      expect(result).toEqual(mockCodebase);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_codebases WHERE repository_url = $1',
        ['https://github.com/user/repo']
      );
    });

    test('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await findCodebaseByRepoUrl('https://github.com/other/repo');

      expect(result).toBeNull();
    });
  });

  describe('findCodebaseByDefaultCwd', () => {
    test('should find codebase by default_cwd', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            id: 'cb-123',
            name: 'test-repo',
            default_cwd: '/workspace/test-repo',
            ai_assistant_type: 'claude',
            repository_url: null,
            commands: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ])
      );

      const result = await findCodebaseByDefaultCwd('/workspace/test-repo');
      expect(result).toBeDefined();
      expect(result?.name).toBe('test-repo');
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_codebases WHERE default_cwd = $1 ORDER BY created_at DESC LIMIT 1',
        ['/workspace/test-repo']
      );
    });

    test('should return null when codebase not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await findCodebaseByDefaultCwd('/workspace/nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('findCodebaseByName', () => {
    test('finds codebase by exact name', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockCodebase]));

      const result = await findCodebaseByName('test-project');

      expect(result).toEqual(mockCodebase);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_codebases WHERE name = $1 ORDER BY created_at DESC LIMIT 1',
        ['test-project']
      );
    });

    test('returns null for non-existent name', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await findCodebaseByName('nonexistent/repo');

      expect(result).toBeNull();
    });
  });

  describe('updateCodebase', () => {
    test('updates default_cwd only', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateCodebase('codebase-123', { default_cwd: '/new/path' });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_codebases SET default_cwd = $1, updated_at = NOW() WHERE id = $2',
        ['/new/path', 'codebase-123']
      );
    });

    test('updates repository_url only', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateCodebase('codebase-123', { repository_url: 'https://github.com/owner/repo' });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_codebases SET repository_url = $1, updated_at = NOW() WHERE id = $2',
        ['https://github.com/owner/repo', 'codebase-123']
      );
    });

    test('updates both default_cwd and repository_url', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateCodebase('codebase-123', {
        default_cwd: '/new/path',
        repository_url: 'https://github.com/owner/repo',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_codebases SET default_cwd = $1, repository_url = $2, updated_at = NOW() WHERE id = $3',
        ['/new/path', 'https://github.com/owner/repo', 'codebase-123']
      );
    });

    test('updates default_branch', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateCodebase('codebase-123', { default_branch: 'develop' });

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_codebases SET default_branch = $1, updated_at = NOW() WHERE id = $2',
        ['develop', 'codebase-123']
      );
    });

    test('throws CodebaseNotFoundError when codebase not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      const error = await updateCodebase('nonexistent', { default_cwd: '/path' }).catch(e => e);

      expect(error).toBeInstanceOf(CodebaseNotFoundError);
      expect(error.message).toBe('Codebase nonexistent not found');
      expect(error.codebaseId).toBe('nonexistent');
    });

    test('does not wrap operational DB errors in CodebaseNotFoundError', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      const error = await updateCodebase('codebase-123', { default_cwd: '/path' }).catch(e => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(CodebaseNotFoundError);
      expect(error.message).toBe('connection refused');
    });

    test('no-ops when no fields provided', async () => {
      await updateCodebase('codebase-123', {});

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('deleteCodebase', () => {
    test('should unlink sessions, conversations, and delete codebase', async () => {
      // First call: unlink sessions
      mockQuery.mockResolvedValueOnce(createQueryResult([], 2));
      // Second call: unlink conversations
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // Third call: delete codebase
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await deleteCodebase('codebase-123');

      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        'UPDATE remote_agent_sessions SET codebase_id = NULL WHERE codebase_id = $1',
        ['codebase-123']
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'UPDATE remote_agent_conversations SET codebase_id = NULL WHERE codebase_id = $1',
        ['codebase-123']
      );
      expect(mockQuery).toHaveBeenNthCalledWith(
        3,
        'DELETE FROM remote_agent_codebases WHERE id = $1',
        ['codebase-123']
      );
    });

    test('should handle codebase with no sessions or conversations', async () => {
      // First call: unlink sessions (none affected)
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
      // Second call: unlink conversations (none affected)
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
      // Third call: delete codebase
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await deleteCodebase('codebase-456');

      expect(mockQuery).toHaveBeenCalledTimes(3);
    });
  });
});
