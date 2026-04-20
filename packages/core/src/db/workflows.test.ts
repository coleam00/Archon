import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import {
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowRunStatus,
  getActiveWorkflowRun,
  getActiveWorkflowRunByPath,
  pauseWorkflowRun,
  resolveWorkflowRunApproval,
  updateWorkflowRun,
  completeWorkflowRun,
  failWorkflowRun,
  updateWorkflowActivity,
  findResumableRun,
  findResumableRunByParentConversation,
  resumeWorkflowRun,
  failOrphanedRuns,
  listWorkflowRuns,
  deleteOldWorkflowRuns,
  deleteWorkflowRun,
} from './workflows';

describe('workflows database', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
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
        ['feature-development', 'conv-456', null, 'Add dark mode support', '{}', null, null]
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
      expect(query).toContain('last_activity_at = NOW()');
    });

    test('updates status to failed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { status: 'failed' });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).toContain('completed_at = NOW()');
      expect(query).toContain('last_activity_at = NOW()');
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
      expect(query).toContain('last_activity_at = NOW()');
      expect(params).toEqual(['running', '{"step":"plan"}', 'workflow-run-123']);
    });

    test('refreshes activity for approval resume transition without marking completed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', {
        status: 'failed',
        metadata: { approval_response: 'approved' },
      });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).toContain('metadata = metadata ||');
      expect(query).toContain('last_activity_at = NOW()');
      expect(query).not.toContain('completed_at = NOW()');
    });

    test('refreshes activity for interactive loop completion handoff without marking completed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', {
        status: 'failed',
        metadata: { loop_completion_input: 'ready' },
      });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).toContain('metadata = metadata ||');
      expect(query).toContain('last_activity_at = NOW()');
      expect(query).not.toContain('completed_at = NOW()');
    });

    test('does nothing when no updates provided', async () => {
      await updateWorkflowRun('workflow-run-123', {});

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('pauseWorkflowRun', () => {
    test('marks the run paused and refreshes last activity', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await pauseWorkflowRun('workflow-run-123', {
        nodeId: 'review',
        message: 'Please review the changes',
        type: 'approval',
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'paused'");
      expect(query).toContain('metadata = metadata ||');
      expect(query).toContain('last_activity_at = NOW()');
      expect(params).toEqual([
        'workflow-run-123',
        JSON.stringify({
          approval: {
            nodeId: 'review',
            message: 'Please review the changes',
            type: 'approval',
          },
        }),
      ]);
    });
  });

  describe('resolveWorkflowRunApproval', () => {
    test('archives approval into lastApproval, removes live approval, and preserves unrelated metadata', async () => {
      const pausedRun: WorkflowRun = {
        ...mockWorkflowRun,
        status: 'paused',
        metadata: {
          approval: {
            nodeId: 'review',
            message: 'Please review the changes',
            type: 'approval',
            captureResponse: true,
          },
          preserved: { nested: true },
        },
      };
      const updatedRun: WorkflowRun = {
        ...pausedRun,
        status: 'failed',
        metadata: {
          preserved: { nested: true },
          approval_response: 'approved',
          rejection_reason: '',
          rejection_count: 0,
          lastApproval: {
            nodeId: 'review',
            message: 'Please review the changes',
            type: 'approval',
            captureResponse: true,
            resolution: 'approved',
            resolvedAt: '2026-04-20T12:00:00.000Z',
            decisionText: 'ship it',
          },
        },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([pausedRun]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([updatedRun]));

      await resolveWorkflowRunApproval('workflow-run-123', {
        status: 'failed',
        resolution: 'approved',
        metadata: {
          approval_response: 'approved',
          rejection_reason: '',
          rejection_count: 0,
        },
        decisionText: 'ship it',
      });

      const [selectQuery, selectParams] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(selectQuery).toBe('SELECT * FROM remote_agent_workflow_runs WHERE id = $1');
      expect(selectParams).toEqual(['workflow-run-123']);

      const [updateQuery, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateQuery).toContain('status = $1');
      expect(updateQuery).toContain('metadata = $2');
      expect(updateQuery).toContain('last_activity_at = NOW()');
      expect(updateQuery).not.toContain('completed_at = NOW()');
      expect(updateParams[0]).toBe('failed');
      expect(updateParams[2]).toBe('workflow-run-123');
      const metadata = JSON.parse(updateParams[1] as string) as Record<string, unknown>;
      expect(metadata.approval).toBeUndefined();
      expect(metadata.preserved).toEqual({ nested: true });
      expect(metadata.approval_response).toBe('approved');
      expect(metadata.rejection_reason).toBe('');
      expect(metadata.rejection_count).toBe(0);
      expect(metadata.lastApproval).toEqual(
        expect.objectContaining({
          nodeId: 'review',
          message: 'Please review the changes',
          type: 'approval',
          captureResponse: true,
          resolution: 'approved',
          decisionText: 'ship it',
        })
      );
      expect(typeof (metadata.lastApproval as Record<string, unknown>).resolvedAt).toBe('string');
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

      await completeWorkflowRun('workflow-run-123', metadata);

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'completed'");
      expect(query).toContain('metadata = metadata ||');
      expect(params).toEqual(['workflow-run-123', JSON.stringify(metadata)]);
    });

    test('uses simple query without metadata merge when no metadata provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await completeWorkflowRun('workflow-run-123');

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).not.toContain('metadata =');
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

    test('merges optional metadata into failure payload', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await failWorkflowRun('workflow-run-123', 'Timeout exceeded', {
        node_counts: { completed: 1, failed: 1, skipped: 0, total: 2 },
      });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toContain(
        JSON.stringify({
          error: 'Timeout exceeded',
          node_counts: { completed: 1, failed: 1, skipped: 0, total: 2 },
        })
      );
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
      expect(query).toContain("status = 'failed'");
      expect(query).toContain('working_path = $2');
      expect(query).not.toContain('conversation_id');
      expect(query).toContain('ORDER BY started_at DESC');
      expect(query).not.toContain('paused');
      expect(query).not.toContain("status = 'running'");
      expect(query).not.toMatch(/--.*\$\d/); // regression guard for #999: $N in SQL comments breaks convertPlaceholders
      expect(params).toEqual(['feature-development', '/repo/path']);
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

  describe('findResumableRunByParentConversation', () => {
    test('only considers failed runs when resolving by parent conversation', async () => {
      const failedRun = {
        ...mockWorkflowRun,
        status: 'failed' as const,
        parent_conversation_id: 'parent-123',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([failedRun]));

      const result = await findResumableRunByParentConversation(
        'feature-development',
        'parent-123'
      );

      expect(result).toEqual(failedRun);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'failed'");
      expect(query).not.toContain('paused');
      expect(params).toEqual(['feature-development', 'parent-123']);
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
    test('transitions non-CLI running runs to failed with completed_at and returns count', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 2));

      const result = await failOrphanedRuns();

      expect(result.count).toBe(2);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'failed'");
      expect(query).toContain('completed_at = NOW()');
      expect(query).toContain("status = 'running'");
      expect(query).toContain("platform_type != 'cli'");
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
    test('updates run to running, clears completed_at, stamps resumedAt, and returns updated row', async () => {
      const failedRun: WorkflowRun = {
        ...mockWorkflowRun,
        status: 'failed',
        completed_at: new Date('2025-01-01T01:00:00Z'),
        metadata: {
          preserved: 'value',
          approval: {
            nodeId: 'review',
            message: 'Please review the changes',
            type: 'approval',
          },
          lastApproval: {
            nodeId: 'review',
            message: 'Please review the changes',
            type: 'approval',
            resolution: 'approved',
            resolvedAt: '2025-01-01T00:30:00.000Z',
          },
        },
      };
      const updatedRun = {
        ...failedRun,
        status: 'running' as const,
        completed_at: null,
        metadata: {
          preserved: 'value',
          lastApproval: {
            nodeId: 'review',
            message: 'Please review the changes',
            type: 'approval',
            resolution: 'approved',
            resolvedAt: '2025-01-01T00:30:00.000Z',
            resumedAt: '2025-01-01T01:05:00.000Z',
          },
        },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([failedRun]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([updatedRun]));

      const result = await resumeWorkflowRun('workflow-run-123');

      expect(result.status).toBe('running');
      expect(result.completed_at).toBeNull();
      const [initialSelectQuery, initialSelectParams] = mockQuery.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(initialSelectQuery).toBe('SELECT * FROM remote_agent_workflow_runs WHERE id = $1');
      expect(initialSelectParams).toEqual(['workflow-run-123']);

      const [updateQuery, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateQuery).toContain('status = $1');
      expect(updateQuery).toContain('metadata = $2');
      expect(updateQuery).toContain('completed_at = NULL');
      expect(updateQuery).toContain('started_at = NOW()');
      expect(updateQuery).toContain('last_activity_at = NOW()');
      expect(updateParams[0]).toBe('running');
      expect(updateParams[2]).toEqual('workflow-run-123');
      const metadata = JSON.parse(updateParams[1] as string) as Record<string, unknown>;
      expect(metadata.preserved).toBe('value');
      expect(metadata.approval).toBeUndefined();
      expect(metadata.lastApproval).toEqual(
        expect.objectContaining({
          resolution: 'approved',
          resolvedAt: '2025-01-01T00:30:00.000Z',
        })
      );
      expect(typeof (metadata.lastApproval as Record<string, unknown>).resumedAt).toBe('string');

      const [selectQuery, selectParams] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(selectQuery).toContain('SELECT *');
      expect(selectParams).toEqual(['workflow-run-123']);
    });

    test('refreshes started_at to NOW so resumed row competes fairly in the path-lock tiebreaker', async () => {
      // Without this refresh, a resumed row carries its original (potentially
      // hours-old) started_at and sorts ahead of any currently-active holder
      // in the older-wins tiebreaker — slipping past the lock and causing
      // two active workflows on the same working_path.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            ...mockWorkflowRun,
            status: 'failed' as const,
            metadata: {},
          },
        ])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'running' as const }])
      );

      await resumeWorkflowRun('workflow-run-123');

      const [updateQuery] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateQuery).toContain('started_at = NOW()');
    });

    test('throws when no row matched (run not found)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(resumeWorkflowRun('nonexistent-id')).rejects.toThrow(
        'Workflow run not found (id: nonexistent-id)'
      );
    });

    test('throws on database error during UPDATE', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'failed' as const, metadata: {} }])
      );
      mockQuery.mockRejectedValueOnce(new Error('Lock timeout'));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to resume workflow run: Lock timeout'
      );
    });

    test('throws on database error during SELECT after UPDATE', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'failed' as const, metadata: {} }])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to read workflow run after update: Connection lost'
      );
    });

    test('throws when row vanishes between UPDATE and SELECT', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'failed' as const, metadata: {} }])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Workflow run vanished after update (id: workflow-run-123)'
      );
    });
  });

  describe('deleteOldWorkflowRuns', () => {
    test('executes BEGIN, two DELETEs (events then runs), and COMMIT', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockResolvedValueOnce(createQueryResult([], 0)) // events DELETE
        .mockResolvedValueOnce(createQueryResult([], 3)) // runs DELETE
        .mockResolvedValueOnce(createQueryResult([])); // COMMIT

      const result = await deleteOldWorkflowRuns(30);

      expect(result.count).toBe(3);
      expect(mockQuery).toHaveBeenCalledTimes(4);
      const [beginSql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(beginSql).toBe('BEGIN');
      const [eventsSql] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(eventsSql).toContain('remote_agent_workflow_events');
      const [runsSql] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(runsSql).toContain("status IN ('completed', 'failed', 'cancelled')");
      const [commitSql] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(commitSql).toBe('COMMIT');
    });

    test('uses PostgreSQL INTERVAL syntax', async () => {
      mockQuery.mockResolvedValue(createQueryResult([], 0));

      await deleteOldWorkflowRuns(7);

      const [eventsSql] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(eventsSql).toContain("INTERVAL '7 days'");
    });

    test('validates olderThanDays is a non-negative integer', async () => {
      await expect(deleteOldWorkflowRuns(-1)).rejects.toThrow('Invalid olderThanDays');
      await expect(deleteOldWorkflowRuns(3.5)).rejects.toThrow('Invalid olderThanDays');
    });

    test('rolls back and throws on database error', async () => {
      mockQuery
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
        .mockResolvedValueOnce(createQueryResult([{ status: 'completed' }])) // SELECT guard
        .mockResolvedValueOnce(createQueryResult([], 1)) // events DELETE
        .mockResolvedValueOnce(createQueryResult([], 1)) // run DELETE
        .mockResolvedValueOnce(createQueryResult([])); // COMMIT

      await deleteWorkflowRun('run-123');

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
