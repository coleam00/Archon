// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = createMockQuery();

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
  listWorkflowNodeSessions,
  upsertWorkflowNodeSession,
  deleteWorkflowNodeSessions,
} from './workflow-node-sessions';

describe('workflow-node-sessions', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  describe('listWorkflowNodeSessions', () => {
    test("returns every provider's row for one workflow scope", async () => {
      const rows = ['claude', 'codex'].map(provider => ({
        workflow_name: 'feature-dev',
        node_id: 'planner',
        scope_key: 'conv-1',
        provider,
        provider_session_id: `sess-${provider}`,
        last_run_id: 'run-1',
        created_at: '2026-05-28T00:00:00.000Z',
        updated_at: '2026-05-28T00:00:00.000Z',
      }));
      mockQuery.mockResolvedValueOnce(createQueryResult(rows));
      const result = await listWorkflowNodeSessions({
        workflow_name: 'feature-dev',
        scope_key: 'conv-1',
      });
      expect(result).toEqual(rows);
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE workflow_name = $1 AND scope_key = $2');
      expect(params).toEqual(['feature-dev', 'conv-1']);
    });
  });

  describe('upsertWorkflowNodeSession', () => {
    test('issues INSERT ... ON CONFLICT ... DO UPDATE with correct params', async () => {
      await upsertWorkflowNodeSession({
        workflow_name: 'feature-dev',
        node_id: 'planner',
        scope_key: 'conv-1',
        provider: 'claude',
        provider_session_id: 'sess-abc',
        last_run_id: 'run-1',
      });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO remote_agent_workflow_node_sessions');
      expect(sql).toContain('ON CONFLICT (workflow_name, node_id, scope_key, provider)');
      expect(sql).toContain('DO UPDATE SET provider_session_id = EXCLUDED.provider_session_id');
      expect(params).toEqual(['feature-dev', 'planner', 'conv-1', 'claude', 'sess-abc', 'run-1']);
    });

    test('accepts a null last_run_id (FK is ON DELETE SET NULL)', async () => {
      await upsertWorkflowNodeSession({
        workflow_name: 'feature-dev',
        node_id: 'planner',
        scope_key: 'conv-1',
        provider: 'claude',
        provider_session_id: 'sess-abc',
        last_run_id: null,
      });
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['feature-dev', 'planner', 'conv-1', 'claude', 'sess-abc', null]);
    });

    test('rethrows DB errors after logging (CLAUDE.md INSERT contract)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      await expect(
        upsertWorkflowNodeSession({
          workflow_name: 'feature-dev',
          node_id: 'planner',
          scope_key: 'conv-1',
          provider: 'claude',
          provider_session_id: 'sess-abc',
          last_run_id: 'run-1',
        })
      ).rejects.toThrow('connection refused');
    });
  });

  describe('deleteWorkflowNodeSessions', () => {
    test('filters by workflow_name only when scope_key and node_id are absent', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 3));
      const result = await deleteWorkflowNodeSessions({ workflow_name: 'feature-dev' });
      expect(result).toEqual({ deleted: 3 });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toBe('DELETE FROM remote_agent_workflow_node_sessions WHERE workflow_name = $1');
      expect(params).toEqual(['feature-dev']);
    });

    test('narrows by scope_key when provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      const result = await deleteWorkflowNodeSessions({
        workflow_name: 'feature-dev',
        scope_key: 'conv-1',
      });
      expect(result).toEqual({ deleted: 1 });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('AND scope_key = $2');
      expect(params).toEqual(['feature-dev', 'conv-1']);
    });

    test('narrows by both scope_key and node_id', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      const result = await deleteWorkflowNodeSessions({
        workflow_name: 'feature-dev',
        scope_key: 'conv-1',
        node_id: 'planner',
      });
      expect(result).toEqual({ deleted: 1 });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('AND scope_key = $2');
      expect(sql).toContain('AND node_id = $3');
      expect(params).toEqual(['feature-dev', 'conv-1', 'planner']);
    });

    test('narrows by node_id without scope_key', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 2));
      const result = await deleteWorkflowNodeSessions({
        workflow_name: 'feature-dev',
        node_id: 'planner',
      });
      expect(result).toEqual({ deleted: 2 });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('AND node_id = $2');
      expect(params).toEqual(['feature-dev', 'planner']);
    });

    test('rowCount of null nullish-coalesces to 0', async () => {
      mockQuery.mockResolvedValueOnce({
        ...createQueryResult([]),
        rowCount: null as unknown as number,
      });
      const result = await deleteWorkflowNodeSessions({ workflow_name: 'feature-dev' });
      expect(result).toEqual({ deleted: 0 });
    });
  });
});
