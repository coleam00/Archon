import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { WorkflowEventRow } from './workflow-events';

// Mock logger to suppress noisy output during tests
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: mock(() => '/home/test/.archon'),
  getArchonConfigPath: mock(() => '/home/test/.archon/config.yaml'),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  getArchonWorktreesPath: mock(() => '/home/test/.archon/worktrees'),
  getDefaultCommandsPath: mock(() => '/app/.archon/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/app/.archon/workflows/defaults'),
}));

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
}));

import {
  createWorkflowEvent,
  listWorkflowEvents,
  listRecentEvents,
  getCompletedDagNodeOutputs,
} from './workflow-events';

describe('workflow-events', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const mockEvent: WorkflowEventRow = {
    id: 'evt-123',
    workflow_run_id: 'run-456',
    event_type: 'step_started',
    step_index: 0,
    step_name: 'plan',
    data: {},
    created_at: '2025-01-01T00:00:00.000Z',
  };

  describe('createWorkflowEvent', () => {
    test('calls pool.query with correct SQL and parameters', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await createWorkflowEvent({
        workflow_run_id: 'run-456',
        event_type: 'step_started',
        step_index: 0,
        step_name: 'plan',
        data: { duration: 100 },
      });

      expect(mockQuery).toHaveBeenCalledWith(
        `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, step_index, step_name, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          expect.any(String), // generated UUID
          'run-456',
          'step_started',
          0,
          'plan',
          JSON.stringify({ duration: 100 }),
        ]
      );
    });

    test('defaults optional fields to null and empty data', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await createWorkflowEvent({
        workflow_run_id: 'run-456',
        event_type: 'workflow_started',
      });

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [
        expect.any(String),
        'run-456',
        'workflow_started',
        null,
        null,
        '{}',
      ]);
    });

    test('does NOT throw when query fails (fire-and-forget)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      // Should NOT throw — fire-and-forget logs error internally
      await createWorkflowEvent({
        workflow_run_id: 'run-456',
        event_type: 'step_started',
      });
    });
  });

  describe('listWorkflowEvents', () => {
    test('returns rows from query result', async () => {
      const events: WorkflowEventRow[] = [
        mockEvent,
        { ...mockEvent, id: 'evt-124', event_type: 'step_completed', step_index: 1 },
      ];
      mockQuery.mockResolvedValueOnce(createQueryResult(events));

      const result = await listWorkflowEvents('run-456');

      expect(result).toEqual(events);
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT * FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1
       ORDER BY created_at ASC`,
        ['run-456']
      );
    });

    test('returns empty array for no results', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await listWorkflowEvents('run-456');

      expect(result).toEqual([]);
    });

    test('throws wrapped error when query fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('timeout'));

      await expect(listWorkflowEvents('run-456')).rejects.toThrow(
        'Failed to list workflow events: timeout'
      );
    });
  });

  describe('listRecentEvents', () => {
    test('returns events filtered by since parameter', async () => {
      const events: WorkflowEventRow[] = [mockEvent];
      mockQuery.mockResolvedValueOnce(createQueryResult(events));

      const since = new Date('2025-01-01T00:00:00.000Z');
      const result = await listRecentEvents('run-456', since);

      expect(result).toEqual(events);
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT * FROM remote_agent_workflow_events
         WHERE workflow_run_id = $1 AND created_at > $2
         ORDER BY created_at ASC`,
        ['run-456', since.toISOString()]
      );
    });

    test('delegates to listWorkflowEvents without since parameter', async () => {
      const events: WorkflowEventRow[] = [mockEvent];
      mockQuery.mockResolvedValueOnce(createQueryResult(events));

      const result = await listRecentEvents('run-456');

      expect(result).toEqual(events);
      // Should use the same query as listWorkflowEvents (no created_at filter)
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT * FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1
       ORDER BY created_at ASC`,
        ['run-456']
      );
    });

    test('returns empty array for no results', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const since = new Date('2025-06-01T00:00:00.000Z');
      const result = await listRecentEvents('run-456', since);

      expect(result).toEqual([]);
    });

    test('throws wrapped error on query failure', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection lost'));

      await expect(listRecentEvents('run-456', new Date())).rejects.toThrow(
        'Failed to list recent workflow events: connection lost'
      );
    });
  });

  describe('getCompletedDagNodeOutputs', () => {
    test('returns map of nodeId → output from node_completed events', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { step_name: 'node-a', data: { node_output: 'output A' } },
          { step_name: 'node-b', data: { node_output: 'output B' } },
        ])
      );

      const result = await getCompletedDagNodeOutputs('run-123');

      expect(result.size).toBe(2);
      expect(result.get('node-a')).toBe('output A');
      expect(result.get('node-b')).toBe('output B');
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('node_completed'), [
        'run-123',
      ]);
    });

    test('parses JSON string data (SQLite path)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { step_name: 'node-a', data: JSON.stringify({ node_output: 'parsed output' }) },
        ])
      );

      const result = await getCompletedDagNodeOutputs('run-456');

      expect(result.size).toBe(1);
      expect(result.get('node-a')).toBe('parsed output');
    });

    test('skips rows with null step_name', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { step_name: null, data: { node_output: 'should be skipped' } },
          { step_name: 'node-a', data: { node_output: 'kept' } },
        ])
      );

      const result = await getCompletedDagNodeOutputs('run-789');

      expect(result.size).toBe(1);
      expect(result.get('node-a')).toBe('kept');
    });

    test('skips rows where node_output is not a string', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { step_name: 'node-a', data: { node_output: 123 } },
          { step_name: 'node-b', data: { duration_ms: 500 } },
          { step_name: 'node-c', data: { node_output: 'valid' } },
        ])
      );

      const result = await getCompletedDagNodeOutputs('run-filter');

      expect(result.size).toBe(1);
      expect(result.get('node-c')).toBe('valid');
    });

    test('skips corrupt JSON rows without losing other rows', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { step_name: 'node-a', data: { node_output: 'good first' } },
          { step_name: 'node-b', data: '{bad json' },
          { step_name: 'node-c', data: { node_output: 'good last' } },
        ])
      );

      const result = await getCompletedDagNodeOutputs('run-corrupt');

      expect(result.size).toBe(2);
      expect(result.get('node-a')).toBe('good first');
      expect(result.get('node-c')).toBe('good last');
    });

    test('returns empty map when no events exist', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getCompletedDagNodeOutputs('run-empty');

      expect(result.size).toBe(0);
    });

    test('throws on DB query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      await expect(getCompletedDagNodeOutputs('run-error')).rejects.toThrow('connection refused');
    });
  });
});
