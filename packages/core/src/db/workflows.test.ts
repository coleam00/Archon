import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { QueryResult } from './adapters/types';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
const mockWithTransaction = mock(
  async <T>(fn: <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>): Promise<T> =>
    fn(mockQuery as <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>)
);
const mockDeleteRetryRefsByRunId = mock(async () => ({
  deletedRefs: [] as string[],
  warnings: [] as string[],
}));

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDatabase: () => ({
    query: mockQuery,
    withTransaction: mockWithTransaction,
    close: mock(() => Promise.resolve()),
    dialect: 'postgres',
    sql: mockPostgresDialect,
  }),
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

mock.module('@archon/git', () => ({
  deleteRetryRefsByRunId: mockDeleteRetryRefsByRunId,
}));

import {
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowRunStatus,
  getActiveWorkflowRun,
  getActiveWorkflowRunByPath,
  updateWorkflowRun,
  claimWorkflowRunForNodeRetry,
  completeWorkflowRun,
  failWorkflowRun,
  updateWorkflowActivity,
  persistRouteDecisionTransition,
  WorkflowRouteDecisionStaleWriteError,
  findResumableRun,
  resumeWorkflowRun,
  cancelWorkflowRun,
  failOrphanedRuns,
  listWorkflowRuns,
  deleteOldWorkflowRuns,
  deleteWorkflowRun,
} from './workflows';

describe('workflows database', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
    mockWithTransaction.mockReset();
    mockWithTransaction.mockImplementation(async fn =>
      fn(mockQuery as <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>)
    );
    mockDeleteRetryRefsByRunId.mockClear();
    mockDeleteRetryRefsByRunId.mockResolvedValue({ deletedRefs: [], warnings: [] });
  });

  const mockWorkflowRun: WorkflowRun = {
    id: 'workflow-run-123',
    workflow_name: 'feature-development',
    conversation_id: 'conv-456',
    parent_conversation_id: null,
    codebase_id: 'codebase-789',
    status: 'running',
    user_message: 'Add dark mode support',
    metadata: {},
    started_at: new Date('2025-01-01T00:00:00Z'),
    completed_at: null,
    last_activity_at: new Date('2025-01-01T00:00:00Z'),
    working_path: null,
  };

  describe('createWorkflowRun', () => {
    test('creates a new workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await createWorkflowRun({
        workflow_name: 'feature-development',
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        user_message: 'Add dark mode support',
      });

      expect(result).toEqual(mockWorkflowRun);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_workflow_runs'),
        [
          'feature-development',
          'conv-456',
          'codebase-789',
          'Add dark mode support',
          '{}',
          null,
          null,
          null,
        ]
      );
    });

    test('creates workflow run with metadata', async () => {
      const runWithMetadata = {
        ...mockWorkflowRun,
        metadata: { github_context: 'Issue #42 context' },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([runWithMetadata]));

      const result = await createWorkflowRun({
        workflow_name: 'feature-development',
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        user_message: 'Add dark mode support',
        metadata: { github_context: 'Issue #42 context' },
      });

      expect(result.metadata).toEqual({ github_context: 'Issue #42 context' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_workflow_runs'),
        [
          'feature-development',
          'conv-456',
          'codebase-789',
          'Add dark mode support',
          JSON.stringify({ github_context: 'Issue #42 context' }),
          null,
          null,
          null,
        ]
      );
    });

    test('creates workflow run without codebase_id', async () => {
      const runWithoutCodebase = { ...mockWorkflowRun, codebase_id: null };
      mockQuery.mockResolvedValueOnce(createQueryResult([runWithoutCodebase]));

      const result = await createWorkflowRun({
        workflow_name: 'feature-development',
        conversation_id: 'conv-456',
        user_message: 'Add dark mode support',
      });

      expect(result.codebase_id).toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_workflow_runs'),
        ['feature-development', 'conv-456', null, 'Add dark mode support', '{}', null, null, null]
      );
    });
  });

  describe('getWorkflowRun', () => {
    test('returns workflow run by id', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await getWorkflowRun('workflow-run-123');

      expect(result).toEqual(mockWorkflowRun);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
        ['workflow-run-123']
      );
    });

    test('returns null for non-existent workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getWorkflowRun('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getWorkflowRunStatus', () => {
    test('returns status for existing workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running' }]));

      const result = await getWorkflowRunStatus('workflow-run-123');

      expect(result).toBe('running');
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
        ['workflow-run-123']
      );
    });

    test('returns null for non-existent workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getWorkflowRunStatus('non-existent');

      expect(result).toBeNull();
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(getWorkflowRunStatus('test-id')).rejects.toThrow(
        'Failed to get workflow run status: Connection refused'
      );
    });
  });

  describe('getActiveWorkflowRun', () => {
    test('returns active workflow run for conversation', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await getActiveWorkflowRun('conv-456');

      expect(result).toEqual(mockWorkflowRun);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(
          "(conversation_id = $1 OR parent_conversation_id = $2) AND status = 'running'"
        ),
        ['conv-456', 'conv-456']
      );
    });

    test('returns null when no active workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getActiveWorkflowRun('conv-456');

      expect(result).toBeNull();
    });
  });

  describe('updateWorkflowRun', () => {
    test('updates status to completed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { status: 'completed' });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).toContain('completed_at = NOW()');
    });

    test('updates status to failed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { status: 'failed' });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).toContain('completed_at = NOW()');
    });

    test('updates metadata', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { metadata: { lastStep: 'plan' } });

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('metadata = metadata ||'), [
        JSON.stringify({ lastStep: 'plan' }),
        'workflow-run-123',
      ]);
    });

    test('updates multiple fields', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', {
        status: 'running',
        metadata: { step: 'plan' },
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).toContain('metadata = metadata ||');
      expect(params).toEqual(['running', '{"step":"plan"}', 'workflow-run-123']);
    });

    test('does nothing when no updates provided', async () => {
      await updateWorkflowRun('workflow-run-123', {});

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('persistRouteDecisionTransition', () => {
    const nextRouteMetadata = {
      loopCounters: { 'review-router': 1 },
      nodeAttempts: { 'review-router': 1 },
      executionSeq: 1,
      routeActivations: {
        fix: {
          route_loop_node_id: 'review-router',
          outcome: 'negative',
          target_node_id: 'fix',
          attempt: 1,
          execution_seq: 1,
        },
      },
    };
    const eventData = {
      from: 'review',
      outcome: 'negative',
      to: 'fix',
      condition: "$review.output.result == '<redacted>'",
      condition_result: false,
      negative_count: 1,
      max_iterations: 10,
      attempt: 1,
      execution_seq: 1,
    };

    test('atomically writes route metadata and route node events in one transaction', async () => {
      const updatedRun = { ...mockWorkflowRun, metadata: nextRouteMetadata };
      mockQuery
        .mockResolvedValueOnce(createQueryResult([{ ...mockWorkflowRun, metadata: {} }]))
        .mockResolvedValueOnce(createQueryResult([updatedRun]))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1));

      const result = await persistRouteDecisionTransition({
        workflow_run_id: 'workflow-run-123',
        expected_execution_seq: 0,
        metadata: nextRouteMetadata,
        event: {
          step_name: 'review-router',
          data: eventData,
        },
        completed_event: {
          step_name: 'review-router',
          data: { node_output: JSON.stringify(eventData) },
        },
      });

      expect(result).toEqual(updatedRun);
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenNthCalledWith(
        1,
        'SELECT * FROM remote_agent_workflow_runs WHERE id = $1 FOR UPDATE',
        ['workflow-run-123']
      );

      const [updateSql, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain('UPDATE remote_agent_workflow_runs');
      expect(updateSql).toContain('metadata = metadata || $2::jsonb');
      expect(updateSql).toContain('RETURNING *');
      expect(updateParams).toEqual(['workflow-run-123', JSON.stringify(nextRouteMetadata)]);

      const [routedInsertSql, routedInsertParams] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(routedInsertSql).toContain('INSERT INTO remote_agent_workflow_events');
      expect(routedInsertParams.slice(1)).toEqual([
        'workflow-run-123',
        'node_routed',
        null,
        'review-router',
        JSON.stringify(eventData),
      ]);

      const [completedInsertSql, completedInsertParams] = mockQuery.mock.calls[3] as [
        string,
        unknown[],
      ];
      expect(completedInsertSql).toContain('INSERT INTO remote_agent_workflow_events');
      expect(completedInsertParams.slice(1)).toEqual([
        'workflow-run-123',
        'node_completed',
        null,
        'review-router',
        JSON.stringify({ node_output: JSON.stringify(eventData) }),
      ]);
    });

    test('rolls back route metadata when the node_routed event write fails', async () => {
      const updatedRun = { ...mockWorkflowRun, metadata: nextRouteMetadata };
      mockQuery
        .mockResolvedValueOnce(createQueryResult([{ ...mockWorkflowRun, metadata: {} }]))
        .mockResolvedValueOnce(createQueryResult([updatedRun]))
        .mockRejectedValueOnce(new Error('event insert failed'));

      await expect(
        persistRouteDecisionTransition({
          workflow_run_id: 'workflow-run-123',
          expected_execution_seq: 0,
          metadata: nextRouteMetadata,
          event: {
            step_name: 'review-router',
            data: eventData,
          },
          completed_event: {
            step_name: 'review-router',
            data: { node_output: JSON.stringify(eventData) },
          },
        })
      ).rejects.toThrow('Failed to persist route decision transition: event insert failed');

      const sqlCalls = mockQuery.mock.calls.map(call => call[0] as string);
      expect(sqlCalls.some(sql => sql.includes('UPDATE remote_agent_workflow_runs'))).toBe(true);
      expect(sqlCalls.some(sql => sql.includes('INSERT INTO remote_agent_workflow_events'))).toBe(
        true
      );
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    });

    test('rejects stale route decision writes before mutating metadata or events', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, metadata: { executionSeq: 2 } }])
      );

      await expect(
        persistRouteDecisionTransition({
          workflow_run_id: 'workflow-run-123',
          expected_execution_seq: 1,
          metadata: nextRouteMetadata,
          event: {
            step_name: 'review-router',
            data: eventData,
          },
          completed_event: {
            step_name: 'review-router',
            data: { node_output: JSON.stringify(eventData) },
          },
        })
      ).rejects.toThrow(WorkflowRouteDecisionStaleWriteError);

      const sqlCalls = mockQuery.mock.calls.map(call => call[0] as string);
      expect(sqlCalls.some(sql => sql.includes('UPDATE remote_agent_workflow_runs'))).toBe(false);
      expect(sqlCalls.some(sql => sql.includes('INSERT INTO remote_agent_workflow_events'))).toBe(
        false
      );
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    });

    test('rolls back malformed existing route metadata before mutating state', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, metadata: { executionSeq: 1.5 } }])
      );

      await expect(
        persistRouteDecisionTransition({
          workflow_run_id: 'workflow-run-123',
          expected_execution_seq: 1,
          metadata: nextRouteMetadata,
          event: {
            step_name: 'review-router',
            data: eventData,
          },
          completed_event: {
            step_name: 'review-router',
            data: { node_output: JSON.stringify(eventData) },
          },
        })
      ).rejects.toThrow('Failed to persist route decision transition');

      const sqlCalls = mockQuery.mock.calls.map(call => call[0] as string);
      expect(sqlCalls.some(sql => sql.includes('UPDATE remote_agent_workflow_runs'))).toBe(false);
      expect(sqlCalls.some(sql => sql.includes('INSERT INTO remote_agent_workflow_events'))).toBe(
        false
      );
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('claimWorkflowRunForNodeRetry', () => {
    test('claims a retryable run, clears completion, and increments metadata retry_epoch in one CAS update', async () => {
      const claimedRun = {
        ...mockWorkflowRun,
        status: 'running' as const,
        metadata: { retry_epoch: 3 },
        completed_at: null,
      };
      mockQuery
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([claimedRun]));

      const result = await claimWorkflowRunForNodeRetry('workflow-run-123');

      expect(result).toEqual(claimedRun);
      const [updateSql, updateParams] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(updateSql).toContain("SET status = 'running'");
      expect(updateSql).toContain('completed_at = NULL');
      expect(updateSql).toContain("jsonb_set(\n         COALESCE(metadata, '{}'::jsonb)");
      expect(updateSql).toContain("WHERE id = $1 AND status IN ('failed', 'cancelled')");
      expect(updateParams).toEqual(['workflow-run-123']);
      expect(mockQuery).toHaveBeenNthCalledWith(
        2,
        'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
        ['workflow-run-123']
      );
    });

    test('throws retry claim conflict when the retryable -> running CAS misses', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([], 0))
        .mockResolvedValueOnce(createQueryResult([{ status: 'running' }]));

      await expect(claimWorkflowRunForNodeRetry('workflow-run-123')).rejects.toThrow(
        'not retry-claimable'
      );
    });
  });

  describe('completeWorkflowRun', () => {
    test('marks workflow run as completed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await completeWorkflowRun('workflow-run-123');

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'completed'"), [
        'workflow-run-123',
      ]);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('completed_at = NOW()'), [
        'workflow-run-123',
      ]);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("AND status = 'running'"), [
        'workflow-run-123',
      ]);
    });

    test('throws when rowCount is 0', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(completeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'not found or not in running state'
      );
    });

    test('merges metadata when provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      const metadata = { node_counts: { completed: 3, failed: 1, skipped: 0, total: 4 } };
      const expectedMetadataSql =
        "metadata = (COALESCE(metadata, '{}'::jsonb) || $2::jsonb) - 'error'";

      await completeWorkflowRun('workflow-run-123', metadata);

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'completed'");
      expect(query).toContain(expectedMetadataSql);
      expect(params).toEqual(['workflow-run-123', JSON.stringify(metadata)]);
    });

    test('clears stale failure error when metadata is provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      const metadata = { node_counts: { completed: 4, failed: 0, skipped: 0, total: 4 } };
      const expectedMetadataSql =
        "metadata = (COALESCE(metadata, '{}'::jsonb) || $2::jsonb) - 'error'";

      await completeWorkflowRun('workflow-run-123', metadata);

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain(expectedMetadataSql);
      expect(params).toEqual(['workflow-run-123', JSON.stringify(metadata)]);
    });

    test('clears stale failure error when no metadata is provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await completeWorkflowRun('workflow-run-123');

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("metadata = (COALESCE(metadata, '{}'::jsonb)) - 'error'");
      expect(params).toEqual(['workflow-run-123']);
    });
  });

  describe('failWorkflowRun', () => {
    test('marks workflow run as failed with error', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await failWorkflowRun('workflow-run-123', 'Step not found: missing.md');

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), [
        'workflow-run-123',
        JSON.stringify({ error: 'Step not found: missing.md' }),
      ]);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('completed_at = NOW()'),
        expect.any(Array)
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("AND status = 'running'"),
        expect.any(Array)
      );
    });

    test('stores error in metadata', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await failWorkflowRun('workflow-run-123', 'Timeout exceeded');

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toContain(JSON.stringify({ error: 'Timeout exceeded' }));
    });

    test('throws when rowCount is 0', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(failWorkflowRun('workflow-run-123', 'some error')).rejects.toThrow(
        'not found or not in running state'
      );
    });
  });

  describe('error handling', () => {
    test('createWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        createWorkflowRun({
          workflow_name: 'test',
          conversation_id: 'conv',
          user_message: 'test',
        })
      ).rejects.toThrow('Failed to create workflow run: Connection refused');
    });

    test('getWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Timeout'));

      await expect(getWorkflowRun('test-id')).rejects.toThrow(
        'Failed to get workflow run: Timeout'
      );
    });

    test('getActiveWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Invalid query'));

      await expect(getActiveWorkflowRun('conv-123')).rejects.toThrow(
        'Failed to get active workflow run: Invalid query'
      );
    });

    test('updateWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Update failed'));

      await expect(updateWorkflowRun('test-id', { status: 'completed' })).rejects.toThrow(
        'Failed to update workflow run: Update failed'
      );
    });

    test('completeWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database locked'));

      await expect(completeWorkflowRun('test-id')).rejects.toThrow(
        'Failed to complete workflow run: Database locked'
      );
    });

    test('failWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Network error'));

      await expect(failWorkflowRun('test-id', 'Some error')).rejects.toThrow(
        'Failed to fail workflow run: Network error'
      );
    });
  });

  describe('metadata serialization', () => {
    test('throws when critical github_context metadata fails to serialize', async () => {
      // Create metadata with a circular reference
      const circularObj: Record<string, unknown> = { github_context: 'Issue context' };
      circularObj.self = circularObj;

      await expect(
        createWorkflowRun({
          workflow_name: 'test',
          conversation_id: 'conv',
          user_message: 'test',
          metadata: circularObj,
        })
      ).rejects.toThrow('Failed to serialize workflow metadata');
    });

    test('falls back to empty object for non-critical metadata serialization failure', async () => {
      // Create metadata WITHOUT github_context but with circular reference
      const circularObj: Record<string, unknown> = { someKey: 'value' };
      circularObj.self = circularObj;

      mockQuery.mockResolvedValueOnce(createQueryResult([{ ...mockWorkflowRun, metadata: {} }]));

      const result = await createWorkflowRun({
        workflow_name: 'test',
        conversation_id: 'conv',
        user_message: 'test',
        metadata: circularObj,
      });

      // Should succeed with empty metadata fallback
      expect(result.metadata).toEqual({});
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params[4]).toBe('{}');
    });

    test('serializes github_context metadata successfully under normal conditions', async () => {
      const runWithContext = {
        ...mockWorkflowRun,
        metadata: { github_context: 'Issue #99: Fix bug' },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([runWithContext]));

      const result = await createWorkflowRun({
        workflow_name: 'test',
        conversation_id: 'conv',
        user_message: 'test',
        metadata: { github_context: 'Issue #99: Fix bug' },
      });

      expect(result.metadata).toEqual({ github_context: 'Issue #99: Fix bug' });
    });
  });

  describe('updateWorkflowActivity', () => {
    test('updates last_activity_at timestamp', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await updateWorkflowActivity('workflow-run-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_workflow_runs SET last_activity_at = NOW() WHERE id = $1',
        ['workflow-run-123']
      );
    });

    test('throws on database error so callers can track failures', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      // Should throw - callers (executor) handle failure tracking
      await expect(updateWorkflowActivity('workflow-run-123')).rejects.toThrow('Connection lost');

      // Verify the query was attempted
      expect(mockQuery).toHaveBeenCalled();
    });
  });

  describe('findResumableRun', () => {
    test('returns the most recent failed run matching workflow name and path', async () => {
      const failedRun = {
        ...mockWorkflowRun,
        status: 'failed' as const,
        working_path: '/repo/path',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([failedRun]));

      const result = await findResumableRun('feature-development', '/repo/path');

      expect(result).toEqual(failedRun);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status IN ('failed', 'paused')");
      expect(query).toContain('working_path = $2');
      expect(query).not.toContain('conversation_id');
      expect(query).toContain('ORDER BY started_at DESC');
      expect(query).not.toMatch(/--.*\$\d/); // regression guard for #999: $N in SQL comments breaks convertPlaceholders
      expect(params).toEqual(['feature-development', '/repo/path', 1]);
    });

    test('returns a stale running run (no activity for >1 day)', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const staleRun = {
        ...mockWorkflowRun,
        status: 'running' as const,
        working_path: '/repo/path',
        last_activity_at: twoDaysAgo,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([staleRun]));

      const result = await findResumableRun('feature-development', '/repo/path');

      expect(result).toEqual(staleRun);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'running'");
      expect(query).toContain('last_activity_at');
      expect(params).toEqual(['feature-development', '/repo/path', 1]);
    });

    test('returns a running run with null last_activity_at (never recorded activity)', async () => {
      const staleRun = {
        ...mockWorkflowRun,
        status: 'running' as const,
        working_path: '/repo/path',
        last_activity_at: null,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([staleRun]));

      const result = await findResumableRun('feature-development', '/repo/path');

      expect(result).toEqual(staleRun);
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('last_activity_at IS NULL');
    });

    test('returns null when no resumable run exists', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await findResumableRun('feature-development', '/repo/path');

      expect(result).toBeNull();
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(findResumableRun('test', '/path')).rejects.toThrow(
        'Failed to find resumable run: Connection refused'
      );
    });
  });

  describe('getActiveWorkflowRunByPath', () => {
    test('returns active or failed run for the given working path', async () => {
      const activeRun = { ...mockWorkflowRun, working_path: '/repo/path' };
      mockQuery.mockResolvedValueOnce(createQueryResult([activeRun]));

      const result = await getActiveWorkflowRunByPath('/repo/path');

      expect(result).toEqual(activeRun);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status IN ('running', 'paused')");
      expect(query).toContain('working_path = $1');
      expect(params).toEqual(['/repo/path']);
    });

    test('includes pending rows within the stale-pending age window', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getActiveWorkflowRunByPath('/repo/path');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      // Fresh `pending` counts as active so the lock is held immediately
      // after pre-create — without this, two near-simultaneous dispatches
      // both pass the guard.
      expect(query).toContain("status = 'pending'");
      // Age window cutoff prevents orphaned pending rows (from crashed
      // dispatches) from permanently blocking a path.
      expect(query).toMatch(/started_at >.*INTERVAL.*milliseconds/);
    });

    test('excludes self and applies older-wins tiebreaker when self is provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const startedAt = new Date('2026-04-14T10:00:00Z');

      await getActiveWorkflowRunByPath('/repo/path', { id: 'self-id', startedAt });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('id != $2');
      // PostgreSQL branch: explicit `::timestamptz` cast on the param so
      // the comparison is chronological, not lexical. SQLite branch wraps
      // both sides in datetime() — covered by tests in adapters/sqlite.test.ts
      // because this suite mocks getDatabaseType as 'postgresql'.
      expect(query).toContain('started_at < $3::timestamptz');
      expect(query).toContain('started_at = $3::timestamptz AND id < $2');
      // selfStartedAt serialized to ISO — bun:sqlite rejects Date bindings.
      expect(params).toEqual(['/repo/path', 'self-id', startedAt.toISOString()]);
    });

    test('skips self exclusion + tiebreaker when self is omitted (no caller context)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getActiveWorkflowRunByPath('/repo/path');

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      // Without `self`, neither the id-exclusion nor the tiebreaker apply.
      expect(query).not.toContain('id !=');
      expect(query).not.toContain('started_at <');
      expect(params).toEqual(['/repo/path']);
    });

    test('orders by (started_at ASC, id ASC) so older-wins is deterministic', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getActiveWorkflowRunByPath('/repo/path');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('ORDER BY started_at ASC, id ASC');
    });

    test('returns null when no active run on path', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getActiveWorkflowRunByPath('/repo/path');

      expect(result).toBeNull();
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(getActiveWorkflowRunByPath('/repo/path')).rejects.toThrow(
        'Failed to get active workflow run by path: Connection refused'
      );
    });
  });

  describe('listWorkflowRuns', () => {
    test('filters by single status string', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listWorkflowRuns({ status: 'running' });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status IN ($1)');
      expect(params[0]).toBe('running');
    });

    test('filters by status array with IN clause', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listWorkflowRuns({ status: ['running', 'failed'] as const });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status IN ($1, $2)');
      expect(params[0]).toBe('running');
      expect(params[1]).toBe('failed');
    });

    test('single-element array uses IN clause', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listWorkflowRuns({ status: ['failed'] });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status IN ($1)');
      expect(params[0]).toBe('failed');
    });

    test('returns results from query', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await listWorkflowRuns();

      expect(result).toEqual([mockWorkflowRun]);
    });
  });

  describe('failOrphanedRuns', () => {
    test('transitions all running runs to failed with completed_at and returns count', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 2));

      const result = await failOrphanedRuns();

      expect(result.count).toBe(2);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'failed'");
      expect(query).toContain('completed_at = NOW()');
      expect(query).toContain("status = 'running'");
      expect(params).toContain(JSON.stringify({ failure_reason: 'server_restart' }));
    });

    test('returns count 0 when no running runs exist', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      const result = await failOrphanedRuns();

      expect(result.count).toBe(0);
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(failOrphanedRuns()).rejects.toThrow(
        'Failed to fail orphaned workflow runs: Connection lost'
      );
    });
  });

  describe('resumeWorkflowRun', () => {
    test('updates run to running, clears completed_at, and returns updated row', async () => {
      const updatedRun = { ...mockWorkflowRun, status: 'running' as const, completed_at: null };
      // UPDATE query returns rowCount 1
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // SELECT query returns the updated row
      mockQuery.mockResolvedValueOnce(createQueryResult([updatedRun]));

      const result = await resumeWorkflowRun('workflow-run-123');

      expect(result.status).toBe('running');
      expect(result.completed_at).toBeNull();
      // First call: UPDATE
      const [updateQuery, updateParams] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(updateQuery).toContain("status = 'running'");
      expect(updateQuery).toContain('completed_at = NULL');
      // $1 = id, $2 = ORPHAN_RESUME_STALE_DAYS. The day param MUST be bound or the
      // CAS predicate's `< $2 days` references an unbound placeholder (PR #1830 C1).
      expect(updateParams).toEqual(['workflow-run-123', 1]);
      // Second call: SELECT
      const [selectQuery, selectParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(selectQuery).toContain('SELECT *');
      expect(selectParams).toEqual(['workflow-run-123']);
    });

    test('refreshes started_at to NOW so resumed row competes fairly in the path-lock tiebreaker', async () => {
      // Without this refresh, a resumed row carries its original (potentially
      // hours-old) started_at and sorts ahead of any currently-active holder
      // in the older-wins tiebreaker — slipping past the lock and causing
      // two active workflows on the same working_path.
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'running' as const }])
      );

      await resumeWorkflowRun('workflow-run-123');

      const [updateQuery] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(updateQuery).toContain('started_at = NOW()');
    });

    test('guards the UPDATE with the resumable-status CAS predicate', async () => {
      // The flip to 'running' must only match a row that is still resumable —
      // failed/paused, or a stale 'running' orphan — so two concurrent resumers
      // can't both win and double-claim the worktree.
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'running' as const }])
      );

      await resumeWorkflowRun('workflow-run-123');

      const [updateQuery, updateParams] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(updateQuery).toContain("status IN ('failed', 'paused')");
      expect(updateQuery).toContain("status = 'running' AND");
      // The stale-orphan arm references $2 — it MUST be bound to the day count.
      expect(updateQuery).toContain('$2');
      expect(updateParams).toEqual(['workflow-run-123', 1]);
    });

    test('throws when no row matched and the run is gone (not found)', async () => {
      // UPDATE returns rowCount 0
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
      // Probe SELECT finds no row → deleted
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(resumeWorkflowRun('nonexistent-id')).rejects.toThrow(
        'Workflow run not found (id: nonexistent-id)'
      );
    });

    test('throws "not resumable" when the run was concurrently activated (CAS miss)', async () => {
      // UPDATE matches nothing because the row is already 'running'
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
      // Probe SELECT reveals the current status
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running' }]));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Workflow run is not resumable (id: workflow-run-123, status: running)'
      );
    });

    test('throws on database error during the disambiguation probe', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0)); // UPDATE matched nothing
      mockQuery.mockRejectedValueOnce(new Error('Connection lost')); // probe fails

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to resume workflow run: Connection lost'
      );
    });

    test('throws on database error during UPDATE', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Lock timeout'));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to resume workflow run: Lock timeout'
      );
    });

    test('throws on database error during SELECT after UPDATE', async () => {
      // UPDATE succeeds
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // SELECT fails
      mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to read workflow run after update: Connection lost'
      );
    });

    test('throws when row vanishes between UPDATE and SELECT', async () => {
      // UPDATE succeeds (rowCount 1)
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // SELECT returns nothing (row deleted between statements)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Workflow run vanished after update (id: workflow-run-123)'
      );
    });
  });

  describe('cancelWorkflowRun', () => {
    test('cancels a non-terminal run and reports { cancelled: true }', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await cancelWorkflowRun('workflow-run-123');

      expect(result).toEqual({ cancelled: true });
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'cancelled'");
      // Must not re-cancel / re-stamp completed_at on an already-finished run.
      expect(query).toContain("status NOT IN ('completed', 'cancelled')");
      expect(params).toEqual(['workflow-run-123']);
    });

    test('reports { cancelled: false } when the run is already terminal (no throw)', async () => {
      // UPDATE matches nothing because the run is completed/cancelled
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(cancelWorkflowRun('workflow-run-123')).resolves.toEqual({ cancelled: false });
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Lock timeout'));

      await expect(cancelWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to cancel workflow run: Lock timeout'
      );
    });
  });

  describe('deleteOldWorkflowRuns', () => {
    test('cleans retry refs and executes BEGIN, two DELETEs (events then runs), and COMMIT', async () => {
      mockQuery
        .mockResolvedValueOnce(
          createQueryResult([{ id: 'old-run-1', working_path: '/workspace/repo' }])
        ) // eligible run SELECT
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockResolvedValueOnce(createQueryResult([], 0)) // events DELETE
        .mockResolvedValueOnce(createQueryResult([], 3)) // runs DELETE
        .mockResolvedValueOnce(createQueryResult([])); // COMMIT

      const result = await deleteOldWorkflowRuns(30);

      expect(result.count).toBe(3);
      expect(mockDeleteRetryRefsByRunId).toHaveBeenCalledWith('/workspace/repo', 'old-run-1');
      expect(mockQuery).toHaveBeenCalledTimes(5);
      const [beginSql] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(beginSql).toBe('BEGIN');
      const [eventsSql] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(eventsSql).toContain('remote_agent_workflow_events');
      const [runsSql] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(runsSql).toContain("status IN ('completed', 'failed', 'cancelled')");
      const [commitSql] = mockQuery.mock.calls[4] as [string, unknown[]];
      expect(commitSql).toBe('COMMIT');
    });

    test('uses PostgreSQL INTERVAL syntax', async () => {
      mockQuery.mockResolvedValue(createQueryResult([], 0));

      await deleteOldWorkflowRuns(7);

      const [eventsSql] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(eventsSql).toContain("INTERVAL '7 days'");
    });

    test('continues old-run deletion when retry ref cleanup fails', async () => {
      mockDeleteRetryRefsByRunId.mockRejectedValueOnce(new Error('ref locked'));
      mockQuery
        .mockResolvedValueOnce(
          createQueryResult([{ id: 'old-run-1', working_path: '/workspace/repo' }])
        )
        .mockResolvedValueOnce(createQueryResult([]))
        .mockResolvedValueOnce(createQueryResult([], 0))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([]));

      const result = await deleteOldWorkflowRuns(30);

      expect(result.count).toBe(1);
      expect(mockQuery).toHaveBeenCalledWith('COMMIT', []);
    });

    test('validates olderThanDays is a non-negative integer', async () => {
      await expect(deleteOldWorkflowRuns(-1)).rejects.toThrow('Invalid olderThanDays');
      await expect(deleteOldWorkflowRuns(3.5)).rejects.toThrow('Invalid olderThanDays');
    });

    test('rolls back and throws on database error', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // eligible run SELECT
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockRejectedValueOnce(new Error('disk full')); // events DELETE fails

      await expect(deleteOldWorkflowRuns(30)).rejects.toThrow(
        'Failed to clean up old workflow runs: disk full'
      );
    });
  });

  describe('deleteWorkflowRun', () => {
    test('deletes events then run within a transaction for terminal run', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockResolvedValueOnce(createQueryResult([{ status: 'completed', working_path: '/repo' }])) // SELECT guard
        .mockResolvedValueOnce(createQueryResult([], 1)) // events DELETE
        .mockResolvedValueOnce(createQueryResult([], 1)) // run DELETE
        .mockResolvedValueOnce(createQueryResult([])); // COMMIT

      await deleteWorkflowRun('run-123');

      expect(mockDeleteRetryRefsByRunId).toHaveBeenCalledWith('/repo', 'run-123');
      expect(mockQuery).toHaveBeenCalledTimes(5);
      const [selectSql] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(selectSql).toContain('SELECT status');
      const [eventsSql] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(eventsSql).toContain('remote_agent_workflow_events');
      const [runsSql] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(runsSql).toContain('remote_agent_workflow_runs');
    });

    test('throws "not found" when run does not exist', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockResolvedValueOnce(createQueryResult([])); // SELECT guard — empty

      await expect(deleteWorkflowRun('missing')).rejects.toThrow('Workflow run not found: missing');
    });

    test('throws when run is not in terminal status', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockResolvedValueOnce(createQueryResult([{ status: 'running' }])); // SELECT guard

      await expect(deleteWorkflowRun('run-active')).rejects.toThrow(
        "Cannot delete workflow run in 'running' status"
      );
    });

    test('throws on database error', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockRejectedValueOnce(new Error('constraint violation'));

      await expect(deleteWorkflowRun('run-123')).rejects.toThrow(
        'Failed to delete workflow run: constraint violation'
      );
    });
  });
});
