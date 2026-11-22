// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';

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
    withTransaction: <T>(fn: (query: typeof mockQuery) => Promise<T>): Promise<T> => fn(mockQuery),
  }),
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import {
  updateWorkflowRun,
  updateWorkflowActivity,
  deleteOldWorkflowRuns,
  deleteWorkflowRun,
} from './workflow-run-writes';

describe('workflow run writes', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  describe('updateWorkflowRun', () => {
    test.each(['completed', 'failed', 'cancelled'] as const)(
      'rejects terminal status %s before querying',
      async status => {
        await expect(
          updateWorkflowRun('workflow-run-123', {
            status,
          } as unknown as Parameters<typeof updateWorkflowRun>[1])
        ).rejects.toThrow(`Terminal workflow status '${status}' requires a lifecycle writer`);
        expect(mockQuery).not.toHaveBeenCalled();
      }
    );

    test('updates a non-terminal status without touching completed_at', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { status: 'running' });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).not.toContain('completed_at');
    });

    test('updates metadata', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { metadata: { lastStep: 'plan' } });

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('metadata = (metadata ||'), [
        JSON.stringify({ lastStep: 'plan' }),
        'workflow-run-123',
      ]);
    });

    // output_root (#2200) is the durable pointer to a run's storage tree. It is
    // write-once at the DB layer via COALESCE so a caller that forgets the
    // null-guard cannot repoint a run mid-life and orphan its artifacts.
    test('writes output_root through COALESCE so the first value wins', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { output_root: '/home/u/.archon/ws/acme/x' });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('output_root = COALESCE(output_root, $1)');
      expect(params).toEqual(['/home/u/.archon/ws/acme/x', 'workflow-run-123']);
    });

    test('output_root placeholder is numbered correctly alongside other fields', async () => {
      // The SET clause is built by hand with positional placeholders, so an
      // off-by-one here would silently bind the wrong value.
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', {
        status: 'running',
        metadata: { step: 'plan' },
        output_root: '/root/x',
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).toContain('output_root = COALESCE(output_root, $3)');
      expect(params).toEqual([
        'running',
        JSON.stringify({ step: 'plan' }),
        '/root/x',
        'workflow-run-123',
      ]);
    });

    // working_path (#2872) is write-once for the same reason as output_root, and it
    // exists for a row created before its checkout was decided: `run --detach` writes
    // the row in the launching process so `Started` names a queryable run, then forks
    // before any worktree exists.
    test('writes working_path through COALESCE so the first value wins', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { working_path: '/home/u/worktrees/task' });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('working_path = COALESCE(working_path, $1)');
      expect(params).toEqual(['/home/u/worktrees/task', 'workflow-run-123']);
    });

    test('working_path placeholder is numbered correctly alongside other fields', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', {
        metadata: { step: 'plan' },
        output_root: '/root/x',
        working_path: '/home/u/worktrees/task',
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('output_root = COALESCE(output_root, $2)');
      expect(query).toContain('working_path = COALESCE(working_path, $3)');
      expect(params).toEqual([
        JSON.stringify({ step: 'plan' }),
        '/root/x',
        '/home/u/worktrees/task',
        'workflow-run-123',
      ]);
    });

    test('does nothing when no updates provided', async () => {
      await updateWorkflowRun('workflow-run-123', {});

      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Update failed'));

      await expect(updateWorkflowRun('test-id', { status: 'running' })).rejects.toThrow(
        'Failed to update workflow run: Update failed'
      );
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

  describe('deleteOldWorkflowRuns', () => {
    test('deletes only the runs it locked and then found eligible, events first', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([{ id: 'old' }, { id: 'kept' }])) // tree lock
        .mockResolvedValueOnce(createQueryResult([{ id: 'old' }, { id: 'kept' }])) // nothing new
        .mockResolvedValueOnce(createQueryResult([{ id: 'old' }, { id: 'unlocked' }])) // eligible
        .mockResolvedValueOnce(createQueryResult([], 0)) // events DELETE
        .mockResolvedValueOnce(createQueryResult([], 1)); // runs DELETE

      const result = await deleteOldWorkflowRuns(30);

      expect(result.count).toBe(1);
      const [lockSql, lockParams] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(lockSql).toContain('FOR UPDATE OF r');
      expect(lockSql).toContain(
        `COALESCE(active_phase_started_at, started_at) < ${mockPostgresDialect.nowMinusDays(1)}`
      );
      expect(lockParams).toEqual([30]);
      const [eventsSql, eventsParams] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(eventsSql).toContain('DELETE FROM remote_agent_workflow_events');
      expect(eventsParams).toEqual([JSON.stringify(['old'])]);
      const [runsSql, runsParams] = mockQuery.mock.calls[4] as [string, unknown[]];
      expect(runsSql).toContain('DELETE FROM remote_agent_workflow_runs');
      expect(runsParams).toEqual([JSON.stringify(['old'])]);
    });

    test('deletes nothing when no locked run is eligible', async () => {
      mockQuery.mockResolvedValue(createQueryResult([], 0));

      expect(await deleteOldWorkflowRuns(7)).toEqual({ count: 0 });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('validates olderThanDays is a non-negative integer', async () => {
      await expect(deleteOldWorkflowRuns(-1)).rejects.toThrow('Invalid olderThanDays');
      await expect(deleteOldWorkflowRuns(3.5)).rejects.toThrow('Invalid olderThanDays');
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('disk full')); // tree lock fails

      await expect(deleteOldWorkflowRuns(30)).rejects.toThrow(
        'Failed to clean up old workflow runs: disk full'
      );
    });
  });

  describe('deleteWorkflowRun', () => {
    test('deletes events then run within a transaction for terminal run', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([{ id: 'run-123' }])) // tree lock
        .mockResolvedValueOnce(createQueryResult([{ id: 'run-123' }])) // nothing new
        .mockResolvedValueOnce(createQueryResult([{ status: 'completed' }])) // SELECT guard
        .mockResolvedValueOnce(createQueryResult([{ open: 0 }])) // open asks guard
        .mockResolvedValueOnce(createQueryResult([{ open: 0 }])) // open waits guard
        .mockResolvedValueOnce(createQueryResult([])) // live descendants guard
        .mockResolvedValueOnce(createQueryResult([], 1)) // events DELETE
        .mockResolvedValueOnce(createQueryResult([], 1)); // run DELETE

      await deleteWorkflowRun('run-123');

      expect(mockQuery).toHaveBeenCalledTimes(8);
      const [lockSql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(lockSql).toContain('FOR UPDATE OF r');
      const [selectSql] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(selectSql).toContain('SELECT status');
      const [eventsSql] = mockQuery.mock.calls[6] as [string, unknown[]];
      expect(eventsSql).toContain('remote_agent_workflow_events');
      const [runsSql] = mockQuery.mock.calls[7] as [string, unknown[]];
      expect(runsSql).toContain('remote_agent_workflow_runs');
    });

    test('throws "not found" when run does not exist', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // tree lock
        .mockResolvedValueOnce(createQueryResult([])); // SELECT guard — empty

      await expect(deleteWorkflowRun('missing')).rejects.toThrow('Workflow run not found: missing');
    });

    test('throws when run is not in terminal status', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([{ id: 'run-active' }])) // tree lock
        .mockResolvedValueOnce(createQueryResult([{ id: 'run-active' }])) // nothing new
        .mockResolvedValueOnce(createQueryResult([{ status: 'running' }])); // SELECT guard

      await expect(deleteWorkflowRun('run-active')).rejects.toThrow(
        "Cannot delete workflow run in 'running' status"
      );
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('constraint violation'));

      await expect(deleteWorkflowRun('run-123')).rejects.toThrow(
        'Failed to delete workflow run: constraint violation'
      );
    });
  });
});
