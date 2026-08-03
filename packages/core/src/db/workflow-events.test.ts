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
  getDatabaseType: () => 'postgresql',
}));

import {
  createWorkflowEvent,
  listWorkflowEvents,
  listRecentEvents,
  getDagResumeSnapshot,
} from './workflow-events';

describe('workflow-events', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockLogger.warn.mockClear();
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
       ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
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
         ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
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
       ORDER BY created_at ASC, COALESCE(event_order, 0) ASC, id ASC`,
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

  describe('getDagResumeSnapshot', () => {
    test('returns outputs and summed tokens from node_completed events', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 'output A', tokens: { input: 40, output: 4 } },
          },
          {
            step_name: 'node-b',
            event_type: 'node_completed',
            data: { node_output: 'output B', tokens: { input: 60, output: 6 } },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-123');

      expect(result.completedNodeOutputs).toEqual(
        new Map([
          ['node-a', 'output A'],
          ['node-b', 'output B'],
        ])
      );
      expect(result.tokens).toEqual({ input: 100, output: 10 });
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('node_completed'), [
        'run-123',
      ]);
    });

    test('returns outputs from node_skipped_prior_success events (multi-resume)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 'output A', tokens: { input: 40, output: 4 } },
          },
          {
            step_name: 'node-b',
            event_type: 'node_skipped_prior_success',
            data: {
              reason: 'prior_success',
              node_output: 'output B',
              tokens: { input: 999, output: 999 },
            },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-resume');

      expect(result.completedNodeOutputs.size).toBe(2);
      expect(result.completedNodeOutputs.get('node-a')).toBe('output A');
      expect(result.completedNodeOutputs.get('node-b')).toBe('output B');
      expect(result.tokens).toEqual({ input: 40, output: 4 });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('node_skipped_prior_success'),
        ['run-resume']
      );
    });

    test('returns outputs when only node_skipped_prior_success rows exist (no node_completed)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-x',
            event_type: 'node_skipped_prior_success',
            data: { reason: 'prior_success', node_output: 'skipped output X' },
          },
          {
            step_name: 'node-y',
            event_type: 'node_skipped_prior_success',
            data: { reason: 'prior_success', node_output: 'skipped output Y' },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-all-skipped');

      expect(result.completedNodeOutputs.size).toBe(2);
      expect(result.completedNodeOutputs.get('node-x')).toBe('skipped output X');
      expect(result.completedNodeOutputs.get('node-y')).toBe('skipped output Y');
      expect(result.tokens).toEqual({ input: 0, output: 0 });
    });

    test('parses JSON string data (SQLite path)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: JSON.stringify({
              node_output: 'parsed output',
              tokens: { input: 8, output: 2 },
            }),
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-456');

      expect(result.completedNodeOutputs.get('node-a')).toBe('parsed output');
      expect(result.tokens).toEqual({ input: 8, output: 2 });
    });

    test('skips rows with null step_name', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: null,
            event_type: 'node_completed',
            data: { node_output: 'should be skipped', tokens: { input: 99, output: 99 } },
          },
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 'kept', tokens: { input: 1, output: 2 } },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-789');

      expect(result.completedNodeOutputs).toEqual(new Map([['node-a', 'kept']]));
      expect(result.tokens).toEqual({ input: 1, output: 2 });
    });

    test('preserves valid outputs while ignoring malformed and non-finite tokens', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 123, tokens: { input: 10, output: 1 } },
          },
          {
            step_name: 'node-b',
            event_type: 'node_completed',
            data: { duration_ms: 500, tokens: { input: 'bad', output: 2 } },
          },
          {
            step_name: 'node-c',
            event_type: 'node_completed',
            data: { node_output: 'valid', tokens: { input: Number.NaN, output: Infinity } },
          },
          {
            step_name: 'node-d',
            event_type: 'node_completed',
            data: { node_output: 'also valid' },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-filter');

      expect(result.completedNodeOutputs).toEqual(
        new Map([
          ['node-c', 'valid'],
          ['node-d', 'also valid'],
        ])
      );
      expect(result.tokens).toEqual({ input: 10, output: 1 });
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });

    test('does not warn when completed events omit optional token usage', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 'output without usage' },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-without-tokens');

      expect(result.completedNodeOutputs).toEqual(new Map([['node-a', 'output without usage']]));
      expect(result.tokens).toEqual({ input: 0, output: 0 });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('skips corrupt JSON rows without losing other rows', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 'good first', tokens: { input: 3, output: 1 } },
          },
          { step_name: 'node-b', event_type: 'node_completed', data: '{bad json' },
          {
            step_name: 'node-c',
            event_type: 'node_completed',
            data: { node_output: 'good last', tokens: { input: 7, output: 2 } },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-corrupt');

      expect(result.completedNodeOutputs.size).toBe(2);
      expect(result.completedNodeOutputs.get('node-a')).toBe('good first');
      expect(result.completedNodeOutputs.get('node-c')).toBe('good last');
      expect(result.tokens).toEqual({ input: 10, output: 3 });
    });

    test('returns an empty snapshot when no events exist', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getDagResumeSnapshot('run-empty');

      expect(result.completedNodeOutputs.size).toBe(0);
      expect(result.tokens).toEqual({ input: 0, output: 0 });
    });

    test('throws on DB query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      await expect(getDagResumeSnapshot('run-error')).rejects.toThrow('connection refused');
    });
  });
});
