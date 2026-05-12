import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { IsolationEnvironmentRow } from '@archon/isolation';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
}));

import {
  getById,
  findActiveByWorkflow,
  listByCodebase,
  create,
  updateStatus,
  updateMetadata,
  countActiveByCodebase,
  getConversationsUsingEnv,
  findStaleEnvironments,
  listAllActiveWithCodebase,
} from './isolation-environments';

describe('isolation-environments', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const sampleEnv: IsolationEnvironmentRow = {
    id: 'env-123',
    codebase_id: 'codebase-456',
    workflow_type: 'issue',
    workflow_id: '42',
    provider: 'worktree',
    working_path: '/workspace/worktrees/project/issue-42',
    branch_name: 'issue-42',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'github',
    metadata: {},
  };

  describe('getById', () => {
    test('returns environment when found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

      const result = await getById('env-123');

      expect(result).toEqual(sampleEnv);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_isolation_environments WHERE id = $1',
        ['env-123']
      );
    });

    test('returns null when not found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findActiveByWorkflow', () => {
    test('finds active environment by workflow identity', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

      const result = await findActiveByWorkflow('codebase-456', 'issue', '42');

      expect(result).toEqual(sampleEnv);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('workflow_type = $2 AND workflow_id = $3'),
        ['codebase-456', 'issue', '42']
      );
    });

    test('returns null when no matching active environment', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await findActiveByWorkflow('codebase-456', 'issue', '99');

      expect(result).toBeNull();
    });
  });

  describe('listByCodebase', () => {
    test('returns all active environments for codebase', async () => {
      const envs = [sampleEnv, { ...sampleEnv, id: 'env-456', workflow_id: '43' }];
      mockQuery.mockResolvedValueOnce(createQueryResult(envs));

      const result = await listByCodebase('codebase-456');

      expect(result).toEqual(envs);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('codebase_id = $1 AND status'),
        ['codebase-456']
      );
    });

    test('returns empty array when no environments', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await listByCodebase('empty-codebase');

      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    test('creates new environment with defaults', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

      const result = await create({
        codebase_id: 'codebase-456',
        workflow_type: 'issue',
        workflow_id: '42',
        working_path: '/workspace/worktrees/project/issue-42',
        branch_name: 'issue-42',
      });

      expect(result).toEqual(sampleEnv);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_isolation_environments'),
        expect.arrayContaining(['codebase-456', 'issue', '42', 'worktree'])
      );
    });

    test('creates environment with custom provider and metadata', async () => {
      const customEnv = { ...sampleEnv, provider: 'container', metadata: { custom: true } };
      mockQuery.mockResolvedValueOnce(createQueryResult([customEnv]));

      await create({
        codebase_id: 'codebase-456',
        workflow_type: 'issue',
        workflow_id: '42',
        provider: 'container',
        working_path: '/workspace/worktrees/project/issue-42',
        branch_name: 'issue-42',
        created_by_platform: 'slack',
        metadata: { custom: true },
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_isolation_environments'),
        [
          'codebase-456',
          'issue',
          '42',
          'container',
          '/workspace/worktrees/project/issue-42',
          'issue-42',
          'slack',
          '{"custom":true}',
        ]
      );
    });
  });

  describe('create - ON CONFLICT behavior', () => {
    test('insert query includes ON CONFLICT clause for active environments', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

      await create({
        codebase_id: 'codebase-456',
        workflow_type: 'issue',
        workflow_id: '42',
        working_path: '/workspace/worktrees/project/issue-42',
        branch_name: 'issue-42',
      });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('ON CONFLICT');
      expect(query).toContain("WHERE status = 'active'");
      expect(query).toContain('DO UPDATE SET');
    });

    test('ON CONFLICT updates working_path and branch_name', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([sampleEnv]));

      await create({
        codebase_id: 'codebase-456',
        workflow_type: 'issue',
        workflow_id: '42',
        working_path: '/workspace/worktrees/project/issue-42-v2',
        branch_name: 'issue-42-v2',
      });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('working_path = EXCLUDED.working_path');
      expect(query).toContain('branch_name = EXCLUDED.branch_name');
    });
  });

  describe('updateStatus', () => {
    test('updates status to destroyed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateStatus('env-123', 'destroyed');

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_isolation_environments SET status = $1 WHERE id = $2',
        ['destroyed', 'env-123']
      );
    });

    test('updates status to active', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateStatus('env-123', 'active');

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_isolation_environments SET status = $1 WHERE id = $2',
        ['active', 'env-123']
      );
    });
  });

  describe('updateMetadata', () => {
    test('merges metadata with existing', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateMetadata('env-123', { pr_number: 42 });

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('metadata = metadata ||'), [
        '{"pr_number":42}',
        'env-123',
      ]);
    });
  });

  describe('countActiveByCodebase', () => {
    test('returns count of active environments', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ count: '5' }]));

      const result = await countActiveByCodebase('codebase-456');

      expect(result).toBe(5);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('COUNT(*)'), ['codebase-456']);
    });

    test('returns 0 when no environments', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ count: '0' }]));

      const result = await countActiveByCodebase('empty-codebase');

      expect(result).toBe(0);
    });
  });

  describe('getConversationsUsingEnv', () => {
    test('returns conversation IDs using the environment', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ id: 'conv-1' }, { id: 'conv-2' }]));

      const result = await getConversationsUsingEnv('env-123');

      expect(result).toEqual(['conv-1', 'conv-2']);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT id FROM remote_agent_conversations WHERE isolation_env_id = $1',
        ['env-123']
      );
    });

    test('returns empty array when no conversations use env', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getConversationsUsingEnv('unused-env');

      expect(result).toEqual([]);
    });
  });

  describe('findStaleEnvironments', () => {
    test('uses default 14 days threshold', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await findStaleEnvironments();

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [, params] = mockQuery.mock.calls[0] as [string, number[]];
      expect(params[0]).toBe(14);
    });

    test('accepts custom staleness threshold', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await findStaleEnvironments(7);

      const [, params] = mockQuery.mock.calls[0] as [string, number[]];
      expect(params[0]).toBe(7);
    });

    test('excludes telegram environments in query', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await findStaleEnvironments();

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("created_by_platform != 'telegram'");
    });

    test('returns environments with codebase info', async () => {
      const mockEnv = {
        ...sampleEnv,
        codebase_default_cwd: '/workspace/myapp',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([mockEnv]));

      const result = await findStaleEnvironments();

      expect(result).toHaveLength(1);
      expect(result[0].codebase_default_cwd).toBe('/workspace/myapp');
    });
  });

  describe('listAllActiveWithCodebase', () => {
    test('returns all active environments with codebase info', async () => {
      const mockEnvs = [
        { ...sampleEnv, id: 'env-1', codebase_default_cwd: '/workspace/app1' },
        { ...sampleEnv, id: 'env-2', codebase_default_cwd: '/workspace/app2' },
      ];
      mockQuery.mockResolvedValueOnce(createQueryResult(mockEnvs));

      const result = await listAllActiveWithCodebase();

      expect(result).toHaveLength(2);
      expect(result[0].codebase_default_cwd).toBe('/workspace/app1');
    });

    test('filters by active status', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listAllActiveWithCodebase();

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'active'");
    });

    test('returns empty array when no active environments', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await listAllActiveWithCodebase();

      expect(result).toEqual([]);
    });
  });
});
