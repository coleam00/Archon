import { beforeEach, describe, expect, mock, test } from 'bun:test';
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
  listWorkflowRunNodeSessions,
  upsertWorkflowRunNodeSession,
} from './workflow-run-node-sessions';

describe('workflow-run-node-sessions', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  test('lists only handles for the requested run', async () => {
    const rows = [
      {
        workflow_run_id: 'run-1',
        node_id: 'scope',
        provider: 'claude',
        provider_session_id: 'session-1',
        created_at: '2026-08-19T00:00:00Z',
        updated_at: '2026-08-19T00:00:00Z',
      },
    ];
    mockQuery.mockResolvedValueOnce(createQueryResult(rows));

    expect(await listWorkflowRunNodeSessions('run-1')).toEqual(rows);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE workflow_run_id = $1');
    expect(params).toEqual(['run-1']);
  });

  test('upserts and replaces one run/node handle', async () => {
    await upsertWorkflowRunNodeSession({
      workflow_run_id: 'run-1',
      node_id: 'scope',
      provider: 'pi',
      provider_session_id: 'session-2',
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (workflow_run_id, node_id)');
    expect(sql).toContain('provider_session_id = EXCLUDED.provider_session_id');
    expect(params).toEqual(['run-1', 'scope', 'pi', 'session-2']);
  });

  test('rethrows checkpoint failures', async () => {
    mockQuery.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      upsertWorkflowRunNodeSession({
        workflow_run_id: 'run-1',
        node_id: 'scope',
        provider: 'claude',
        provider_session_id: 'session-1',
      })
    ).rejects.toThrow('database unavailable');
  });
});
