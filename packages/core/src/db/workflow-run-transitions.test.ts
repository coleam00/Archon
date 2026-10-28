// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import { mockWorkflowRun } from '../test/mocks/workflow-run';

const mockQuery = createMockQuery();

// Mock the connection module before importing the module under test.
// `getDatabase().withTransaction` runs its callback against the SAME mockQuery,
// so a transactional function's statements land in mockQuery.mock.calls in
// order, exactly like the non-transactional ones.
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDatabase: () => ({
    // The pre-transaction artifact read finds no run, so no artifacts are walked.
    query: () => Promise.resolve(createQueryResult([])),
    withTransaction: <T>(fn: (query: typeof mockQuery) => Promise<T>): Promise<T> => fn(mockQuery),
  }),
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import {
  createWorkflowRun,
  completeWorkflowRun,
  failWorkflowRun,
  cancelResumableRunsForConversation,
  cancelWorkflowRun,
  cancelFanOutRun,
} from './workflow-run-transitions';

describe('workflow run transitions', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  function mockTerminalSnapshot(
    status: 'completed' | 'failed' | 'cancelled',
    id = mockWorkflowRun.id
  ): void {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([{ ...mockWorkflowRun, id, status, completed_at: new Date() }])
    );
    mockQuery.mockResolvedValueOnce(createQueryResult([]));
  }

  describe('createWorkflowRun', () => {
    beforeEach(() => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    });
    test('creates a new workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await createWorkflowRun({
        workflow_name: 'feature-development',
        origin: { conversationId: 'conv-456' },
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
          null,
          null, // adopted_from_run_id (#2747)
          JSON.stringify({ conversationId: 'conv-456' }),
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
        origin: { conversationId: 'conv-456' },
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
          null,
          null, // adopted_from_run_id (#2747)
          JSON.stringify({ conversationId: 'conv-456' }),
        ]
      );
    });

    test('creates workflow run without codebase_id', async () => {
      const runWithoutCodebase = { ...mockWorkflowRun, codebase_id: null };
      mockQuery.mockResolvedValueOnce(createQueryResult([runWithoutCodebase]));

      const result = await createWorkflowRun({
        workflow_name: 'feature-development',
        origin: { conversationId: 'conv-456' },
        user_message: 'Add dark mode support',
      });

      expect(result.codebase_id).toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_workflow_runs'),
        [
          'feature-development',
          'conv-456',
          null,
          'Add dark mode support',
          '{}',
          null,
          null,
          null,
          null,
          null, // adopted_from_run_id (#2747)
          JSON.stringify({ conversationId: 'conv-456' }),
        ]
      );
    });
  });

  describe('completeWorkflowRun', () => {
    test('marks workflow run as completed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('completed');

      await completeWorkflowRun('workflow-run-123', { duration_ms: 123 });

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'completed'"), [
        'workflow-run-123',
      ]);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('completed_at = NOW()'), [
        'workflow-run-123',
      ]);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("AND status = 'running'"), [
        'workflow-run-123',
      ]);
      const [eventQuery, eventParams] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(eventQuery).toContain('INSERT INTO remote_agent_workflow_events');
      expect(eventParams[2]).toBe('workflow_completed');
      expect(JSON.parse(eventParams[5] as string)).toMatchObject({
        duration_ms: 123,
        terminal_record: expect.any(Object),
      });
    });

    test('throws when rowCount is 0', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(completeWorkflowRun('workflow-run-123', { duration_ms: 123 })).rejects.toThrow(
        'not found or not in running state'
      );
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('merges metadata when provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('completed');
      const metadata = { node_counts: { completed: 3, failed: 1, skipped: 0, total: 4 } };

      await completeWorkflowRun('workflow-run-123', { duration_ms: 123 }, metadata);

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'completed'");
      expect(query).toContain('metadata = metadata ||');
      expect(params).toEqual(['workflow-run-123', JSON.stringify(metadata)]);
    });

    test('uses simple query without metadata merge when no metadata provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('completed');

      await completeWorkflowRun('workflow-run-123', { duration_ms: 123 });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).not.toContain('metadata =');
      expect(params).toEqual(['workflow-run-123']);
    });

    test('does not commit completion when its audit insert fails', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('completed');
      mockQuery.mockRejectedValueOnce(new Error('audit unavailable'));

      await expect(completeWorkflowRun('workflow-run-123', { duration_ms: 123 })).rejects.toThrow(
        'Failed to complete workflow run: audit unavailable'
      );
    });
  });

  describe('failWorkflowRun', () => {
    test('marks workflow run as failed with error', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('failed');

      expect(await failWorkflowRun('workflow-run-123', 'Step not found: missing.md')).toEqual({
        failed: true,
      });

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), [
        'workflow-run-123',
        JSON.stringify({ error: 'Step not found: missing.md' }),
      ]);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('completed_at = NOW()'),
        expect.any(Array)
      );
      const [eventQuery, eventParams] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(eventQuery).toContain('INSERT INTO remote_agent_workflow_events');
      expect(eventParams[2]).toBe('workflow_failed');
      expect(JSON.parse(eventParams[5] as string)).toMatchObject({
        terminal_record: expect.any(Object),
        error: 'Step not found: missing.md',
      });
      expect(mockQuery).toHaveBeenCalledWith(
        // Pending too: capture, artifact setup, and credential resolution all run before
        // the row goes running, and a running-only guard left those failures pending forever.
        expect.stringContaining("AND status IN ('running', 'pending')"),
        expect.any(Array)
      );
    });

    test('stores error in metadata', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('failed');

      await failWorkflowRun('workflow-run-123', 'Timeout exceeded');

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toContain(JSON.stringify({ error: 'Timeout exceeded' }));
    });

    test('records the stop reason and its signal on the run row', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('failed');

      await failWorkflowRun('workflow-run-123', 'Process terminated (SIGINT)', {
        exitReason: 'process_terminated',
        signal: 'SIGINT',
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(JSON.parse(params[1] as string)).toEqual({
        error: 'Process terminated (SIGINT)',
        stop_reason: { reason: 'process_terminated', signal: 'SIGINT' },
      });
      // Written wholesale: a previous failure's copy is removed before the merge, so
      // SQLite's recursive json_patch cannot leave its signal under a new reason.
      expect(query).toContain("metadata - 'scheduled_resume' - 'stop_reason'");
      // The terminal event's bare `exit_reason` string is a shipped persisted value the
      // telemetry reader parses; the row's structured copy does not replace it.
      const [eventQuery, eventParams] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(eventQuery).toContain('INSERT INTO remote_agent_workflow_events');
      expect(eventParams[2]).toBe('workflow_failed');
      expect(JSON.parse(eventParams[5] as string)).toMatchObject({
        exit_reason: 'process_terminated',
      });
    });

    test('omits the stop reason when the caller gave no exit reason', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('failed');

      await failWorkflowRun('workflow-run-123', 'Bash node failed');

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(JSON.parse(params[1] as string)).toEqual({ error: 'Bash node failed' });
    });

    test('throws when the run does not exist', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(failWorkflowRun('workflow-run-123', 'some error')).rejects.toThrow(
        'not found or not in pending/running state'
      );
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('preserves a status lookup failure after a lost update', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(failWorkflowRun('workflow-run-123', 'some error')).rejects.toThrow(
        'Failed to get workflow run status: Connection refused'
      );
    });

    test('does not commit failure when its terminal audit insert fails', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('failed');
      mockQuery.mockRejectedValueOnce(new Error('audit unavailable'));

      await expect(failWorkflowRun('workflow-run-123', 'some error')).rejects.toThrow(
        'Failed to fail workflow run: audit unavailable'
      );
    });
  });

  describe('error handling', () => {
    test('createWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        createWorkflowRun({
          workflow_name: 'test',
          origin: { conversationId: 'conv' },
          user_message: 'test',
        })
      ).rejects.toThrow('Failed to create workflow run: Connection refused');
    });

    test('completeWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database locked'));

      await expect(completeWorkflowRun('test-id', { duration_ms: 123 })).rejects.toThrow(
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
    test.each(['github_context', 'ai_configuration'])(
      'throws when critical %s metadata fails to serialize',
      async key => {
        const circularObj: Record<string, unknown> = { [key]: 'required' };
        circularObj.self = circularObj;

        await expect(
          createWorkflowRun({
            workflow_name: 'test',
            origin: { conversationId: 'conv' },
            user_message: 'test',
            metadata: circularObj,
          })
        ).rejects.toThrow('Failed to serialize workflow metadata');
        expect(mockQuery).not.toHaveBeenCalled();
      }
    );

    test('falls back to empty object for non-critical metadata serialization failure', async () => {
      // Create metadata WITHOUT github_context but with circular reference
      const circularObj: Record<string, unknown> = { someKey: 'value' };
      circularObj.self = circularObj;

      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([{ ...mockWorkflowRun, metadata: {} }]));

      const result = await createWorkflowRun({
        workflow_name: 'test',
        origin: { conversationId: 'conv' },
        user_message: 'test',
        metadata: circularObj,
      });

      // Should succeed with empty metadata fallback
      expect(result.metadata).toEqual({});
      const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(params[4]).toBe('{}');
    });

    test('serializes github_context metadata successfully under normal conditions', async () => {
      const runWithContext = {
        ...mockWorkflowRun,
        metadata: { github_context: 'Issue #99: Fix bug' },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([runWithContext]));

      const result = await createWorkflowRun({
        workflow_name: 'test',
        origin: { conversationId: 'conv' },
        user_message: 'test',
        metadata: { github_context: 'Issue #99: Fix bug' },
      });

      expect(result.metadata).toEqual({ github_context: 'Issue #99: Fix bug' });
    });
  });

  describe('cancelResumableRunsForConversation', () => {
    test('locks the conversation snapshot and atomically cancels only paused/failed rows', async () => {
      const paused = { ...mockWorkflowRun, id: 'run-a', status: 'paused' as const };
      const running = { ...mockWorkflowRun, id: 'run-b', status: 'running' as const };
      const failed = { ...mockWorkflowRun, id: 'run-c', status: 'failed' as const };
      mockQuery
        .mockResolvedValueOnce(createQueryResult([paused, running, failed]))
        .mockResolvedValueOnce(createQueryResult([], 2));
      for (const id of ['run-a', 'run-c']) {
        mockTerminalSnapshot('cancelled', id);
        mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      }

      const result = await cancelResumableRunsForConversation('conv-1');

      expect(result).toEqual([paused, failed]);
      expect(mockQuery).toHaveBeenCalledTimes(8);
      const [selectSql, selectParams] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(selectSql).toContain(
        'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs'
      );
      expect(selectSql).toContain('conversation_id = $1 OR parent_conversation_id = $2');
      expect(selectSql).toContain('FOR UPDATE');
      expect(selectParams).toEqual(['conv-1', 'conv-1']);
      const [updateSql, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain("status IN ('paused', 'failed')");
      expect(updateSql).not.toContain("'running'");
      expect(updateSql).not.toContain("'pending'");
      expect(updateSql).not.toContain('RETURNING');
      expect(updateParams).toEqual(['conv-1', 'conv-1']);
      for (const [index, runId] of ['run-a', 'run-c'].entries()) {
        const [eventSql, eventParams] = mockQuery.mock.calls[index * 3 + 4] as [string, unknown[]];
        expect(eventSql).toContain('INSERT INTO remote_agent_workflow_events');
        expect(eventParams[1]).toBe(runId);
        expect(eventParams[2]).toBe('workflow_cancelled');
      }
    });

    test('returns without writing when the locked snapshot has nothing resumable', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'running' as const }])
      );

      expect(await cancelResumableRunsForConversation('conv-1')).toEqual([]);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('rolls back instead of reporting a stale snapshot count', async () => {
      mockQuery
        .mockResolvedValueOnce(
          createQueryResult([{ ...mockWorkflowRun, status: 'paused' as const }])
        )
        .mockResolvedValueOnce(createQueryResult([], 0));

      await expect(cancelResumableRunsForConversation('conv-1')).rejects.toThrow(
        'Resumable run snapshot changed during reset'
      );
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(cancelResumableRunsForConversation('conv-1')).rejects.toThrow(
        'Failed to cancel resumable runs for conversation: Connection refused'
      );
    });
  });

  describe('cancelWorkflowRun', () => {
    test('cancels a non-terminal run and reports { cancelled: true }', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('cancelled');
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await cancelWorkflowRun('workflow-run-123', {
        step_name: 'halt',
        reason: 'operator requested',
      });

      expect(result).toEqual({ cancelled: true });
      expect(mockQuery).toHaveBeenCalledTimes(4);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'cancelled'");
      // Must not re-cancel / re-stamp completed_at on an already-finished run.
      expect(query).toContain('status NOT IN ($2, $3)');
      expect(params).toEqual(['workflow-run-123', 'completed', 'cancelled']);
      const [eventQuery, eventParams] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(eventQuery).toContain('INSERT INTO remote_agent_workflow_events');
      expect(eventParams.slice(1, 5)).toEqual([
        'workflow-run-123',
        'workflow_cancelled',
        null,
        'halt',
      ]);
      expect(JSON.parse(eventParams[5] as string)).toMatchObject({
        reason: 'operator requested',
        terminal_record: expect.any(Object),
      });
    });

    test('persists cancellation warnings without truncation', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('cancelled');
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      const warnings = [`${'Held output. '.repeat(30)}Use lsof on the checkout.`];
      await cancelWorkflowRun('workflow-run-123', {
        cancel_reason: 'operator',
        reason: warnings.join('\n'),
        warnings,
      });
      const params = mockQuery.mock.calls[3]?.[1];
      if (!Array.isArray(params)) throw new Error('Missing cancellation event');
      const data: Record<string, unknown> = JSON.parse(String(params[5]));
      expect(data.reason).toBe(warnings[0]);
      expect(params[2]).toBe('workflow_cancelled');
      expect(data.warnings).toEqual(warnings);
    });

    test('reports { cancelled: false } when the run is already terminal (no throw)', async () => {
      // UPDATE matches nothing because the run is completed/cancelled
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(cancelWorkflowRun('workflow-run-123')).resolves.toEqual({ cancelled: false });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Lock timeout'));

      await expect(cancelWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to cancel workflow run: Lock timeout'
      );
    });
  });

  describe('cancelFanOutRun', () => {
    test('persists the engine reason and cancelled status in one update', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockTerminalSnapshot('cancelled');
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await expect(cancelFanOutRun('workflow-run-123', 'fan_out_orphan')).resolves.toEqual({
        cancelled: true,
      });

      expect(mockQuery).toHaveBeenCalledTimes(4);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'cancelled'");
      expect(query).toContain('metadata =');
      expect(query).toContain('status NOT IN ($3, $4)');
      expect(params).toEqual([
        'workflow-run-123',
        JSON.stringify({ cancelled_reason: 'fan_out_orphan' }),
        'completed',
        'cancelled',
      ]);
      const [eventQuery, eventParams] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(eventQuery).toContain('INSERT INTO remote_agent_workflow_events');
      expect(eventParams.slice(1, 5)).toEqual([
        'workflow-run-123',
        'workflow_cancelled',
        null,
        null,
      ]);
      expect(JSON.parse(eventParams[5] as string)).toMatchObject({
        reason: 'fan_out_orphan',
        terminal_record: expect.any(Object),
      });
    });

    test('does not tag an already-terminal run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(cancelFanOutRun('workflow-run-123', 'fan_out_orphan')).resolves.toEqual({
        cancelled: false,
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('surfaces a failed atomic update', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Lock timeout'));

      await expect(cancelFanOutRun('workflow-run-123', 'fan_out_orphan')).rejects.toThrow(
        'Failed to cancel fan-out run: Lock timeout'
      );
    });
  });
});
