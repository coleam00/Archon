import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import { Codebase } from '../types';

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
  findCodebaseByName,
  updateCodebase,
  deleteCodebase,
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
    ai_assistant_type: 'claude',
    commands: { plan: { path: '.claude/commands/plan.md', description: 'Plan feature' } },
    created_at: new Date(),
    updated_at: new Date(),
  };

  describe('createCodebase', () => {
    test('creates codebase with all fields', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockCodebase]));

      const result = await createCodebase({
        name: 'test-project',
        repository_url: 'https://github.com/user/repo',
        default_cwd: '/workspace/test-project',
        ai_assistant_type: 'claude',
      });

      expect(result).toEqual(mockCodebase);
      expect(mockQuery).toHaveBeenCalledWith(
        'INSERT INTO remote_agent_codebases (name, repository_url, default_cwd, ai_assistant_type) VALUES ($1, $2, $3, $4) RETURNING *',
        ['test-project', 'https://github.com/user/repo', '/workspace/test-project', 'claude']
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
        'INSERT INTO remote_agent_codebases (name, repository_url, default_cwd, ai_assistant_type) VALUES ($1, $2, $3, $4) RETURNING *',
        ['test-project', null, '/workspace/test-project', 'claude']
      );
    });

    test('defaults ai_assistant_type to claude', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockCodebase]));

      await createCodebase({
        name: 'test-project',
        default_cwd: '/workspace/test-project',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['claude'])
      );
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

    test('throws when codebase not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(updateCodebase('nonexistent', { default_cwd: '/path' })).rejects.toThrow(
        'Codebase nonexistent not found'
      );
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
