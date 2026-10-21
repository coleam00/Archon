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
    withTransaction: <T>(fn: (query: typeof mockQuery) => Promise<T>): Promise<T> => fn(mockQuery),
  }),
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import { WorkflowNotResumableError } from '@archon/workflows/store';
import {
  findResumableRun,
  findResumableRunByParentConversation,
  resumeWorkflowRun,
} from './workflow-run-resume';

describe('workflow run resume', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
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
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
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

  describe('findResumableRunByParentConversation', () => {
    test('scopes by workflow name, parent conversation and codebase', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await findResumableRunByParentConversation('piv', 'conv-1', 'codebase-789');

      expect(result).toEqual(mockWorkflowRun);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('workflow_name = $1');
      expect(query).toContain('parent_conversation_id = $2');
      expect(query).toContain('codebase_id = $3');
      expect(params).toEqual(['piv', 'conv-1', 'codebase-789']);
    });

    test('prefers a paused run over a newer failed one (paused-first ordering)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await findResumableRunByParentConversation('piv', 'conv-1', 'cb');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status IN ('failed', 'paused')");
      // Status is the primary sort key: an open gate auto-resumes, while a
      // failed candidate is gated behind an explicit user prompt. Ordering by
      // started_at alone lets a newer failure shadow an older waiting gate.
      expect(query).toContain("ORDER BY CASE WHEN status = 'paused' THEN 0 ELSE 1 END");
      // Recency still breaks ties within a status.
      expect(query).toContain('started_at DESC');
    });

    test('returns null when no run matches', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await findResumableRunByParentConversation('piv', 'conv-1', 'cb');

      expect(result).toBeNull();
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(findResumableRunByParentConversation('piv', 'conv-1', 'cb')).rejects.toThrow(
        'Failed to find resumable run by parent conversation: Connection refused'
      );
    });
  });

  describe('resumeWorkflowRun', () => {
    test('updates run to running, clears completed_at, and returns updated row', async () => {
      const updatedRun = { ...mockWorkflowRun, status: 'running' as const, completed_at: null };
      // Pre-CAS read of the metadata about to be cleared (no prior error here)
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running', metadata: {} }]));
      // UPDATE query returns rowCount 1
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // SELECT query returns the updated row
      mockQuery.mockResolvedValueOnce(createQueryResult([updatedRun]));

      const result = await resumeWorkflowRun('workflow-run-123');

      expect(result.status).toBe('running');
      expect(result.completed_at).toBeNull();
      // First call: the row-pinning read of the error the CAS is about to clear.
      const [priorQuery, priorParams] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(priorQuery).toContain('SELECT w.status, w.metadata, q.resource_key');
      // Postgres row lock — without it the value read is not guaranteed to be the
      // value the CAS clears, so the preserved error could be stale (#2348).
      expect(priorQuery).toContain('FOR UPDATE');
      expect(priorParams).toEqual(['workflow-run-123']);
      // Second call: UPDATE
      const [updateQuery, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateQuery).toContain("status = 'running'");
      expect(updateQuery).toContain('completed_at = NULL');
      expect(updateQuery).toContain('metadata = metadata || $3::jsonb');
      // $1 = id, $2 = ORPHAN_RESUME_STALE_DAYS. The day param MUST be bound or the
      // CAS predicate's `< $2 days` references an unbound placeholder (PR #1830 C1).
      expect(updateParams).toEqual(['workflow-run-123', 1, expect.any(String)]);
      expect(JSON.parse(String(updateParams[2]))).toEqual({
        tool_call_attention: null,
        error: null,
        stop_reason: null,
        continuation_retry_at: null,
        capacity_wait: null,
        source_release: null,
        execution_claim: expect.any(String),
      });
      // Third call: SELECT
      const [selectQuery, selectParams] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(selectQuery).toContain('SELECT *');
      expect(selectParams).toEqual(['workflow-run-123']);
      // No prior error → no audit event (only three statements ran).
      expect(mockQuery.mock.calls).toHaveLength(3);
    });

    test('refreshes started_at to NOW so resumed row competes fairly in the path-lock tiebreaker', async () => {
      // Without this refresh, a resumed row carries its original (potentially
      // hours-old) started_at and sorts ahead of any currently-active holder
      // in the older-wins tiebreaker — slipping past the lock and causing
      // two active workflows on the same working_path.
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running', metadata: {} }]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'running' as const }])
      );

      await resumeWorkflowRun('workflow-run-123');

      const [updateQuery] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateQuery).toContain('started_at = NOW()');
    });

    test('guards the UPDATE with the resumable-status CAS predicate', async () => {
      // The flip to 'running' must only match a row that is still resumable —
      // failed/paused, or a stale 'running' orphan — so two concurrent resumers
      // can't both win and double-claim the worktree.
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running', metadata: {} }]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'running' as const }])
      );

      await resumeWorkflowRun('workflow-run-123');

      const [updateQuery, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(updateQuery).toContain("status IN ('failed', 'paused')");
      expect(updateQuery).toContain("status = 'running' AND");
      // The stale-orphan arm references $2 — it MUST be bound to the day count.
      expect(updateQuery).toContain('$2');
      expect(updateParams).toEqual(['workflow-run-123', 1, expect.any(String)]);
      expect(JSON.parse(String(updateParams[2]))).toEqual({
        tool_call_attention: null,
        error: null,
        stop_reason: null,
        continuation_retry_at: null,
        capacity_wait: null,
        source_release: null,
        execution_claim: expect.any(String),
      });
    });

    test('preserves the cleared error as a workflow_resumed event (CAS winner only)', async () => {
      // The resume clears metadata.error, which for a SIGTERM-killed CLI run is
      // the only record that a legacy run ever failed — no workflow_failed/node_failed
      // event was written on that legacy path (#2348). The clear must not lose it.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { status: 'running', metadata: { error: 'Process terminated (SIGTERM)' } },
        ])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1)); // CAS wins
      mockQuery.mockResolvedValueOnce(createQueryResult([])); // event INSERT
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'running' as const }])
      );

      await resumeWorkflowRun('workflow-run-123');

      const [eventQuery, eventParams] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(eventQuery).toContain('INSERT INTO remote_agent_workflow_events');
      // [id, workflow_run_id, event_type, step_index, step_name, data]
      expect(eventParams[1]).toBe('workflow-run-123');
      expect(eventParams[2]).toBe('workflow_resumed');
      expect(eventParams[5]).toBe(JSON.stringify({ error: 'Process terminated (SIGTERM)' }));
    });

    test('claims quota continuation and audits it in the winning resume transaction', async () => {
      const scheduled = {
        reason: 'quota' as const,
        resumeAt: '2026-08-25T10:00:00.000Z',
        deadlineAt: '2026-08-26T10:00:00.000Z',
        attempt: 1,
        maxAttempts: 2,
        error: 'usage limit reached',
      };
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ status: 'failed', metadata: { scheduled_resume: scheduled } }])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'running' as const }])
      );

      await resumeWorkflowRun('workflow-run-123', {
        kind: 'quota',
        attempt: scheduled.attempt,
        resumeAt: scheduled.resumeAt,
      });

      const [, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(JSON.parse(updateParams[2] as string)).toMatchObject({
        error: null,
        scheduled_resume: {
          ...scheduled,
          triggeredAt: expect.any(String),
        },
      });
      const [, resumedParams] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(resumedParams[2]).toBe('workflow_resumed');
      expect(resumedParams[5]).toBe('{}');
      const [eventQuery, eventParams] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(eventQuery).toContain('INSERT INTO remote_agent_workflow_events');
      expect(eventParams[2]).toBe('quota_resume_triggered');
      expect(eventParams[5]).toBe(
        JSON.stringify({ attempt: scheduled.attempt, resume_at: scheduled.resumeAt })
      );
    });

    test('refuses a stale quota cursor without claiming a newer scheduled attempt', async () => {
      const current = {
        reason: 'quota' as const,
        resumeAt: '2026-08-25T12:00:00.000Z',
        deadlineAt: '2026-08-26T10:00:00.000Z',
        attempt: 2,
        maxAttempts: 3,
      };
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ status: 'failed', metadata: { scheduled_resume: current } }])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'failed' }]));

      await expect(
        resumeWorkflowRun('workflow-run-123', {
          kind: 'quota',
          attempt: 1,
          resumeAt: '2026-08-25T10:00:00.000Z',
        })
      ).rejects.toThrow(WorkflowNotResumableError);

      expect(mockQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
    });

    test('writes no event when the CAS loses, even though an error was read', async () => {
      // A concurrent resumer already flipped the row: this caller read the error
      // but its UPDATE matched nothing, so it must write NOTHING at all —
      // otherwise a lost race still emits an audit event for a clear it never did.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { status: 'running', metadata: { error: 'Process terminated (SIGTERM)' } },
        ])
      );
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0)); // CAS loses
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running' }])); // probe

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        WorkflowNotResumableError
      );

      const inserts = mockQuery.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO remote_agent_workflow_events')
      );
      expect(inserts).toHaveLength(0);
    });

    test('throws when no row matched and the run is gone (not found)', async () => {
      // Pre-CAS read finds nothing (row already deleted)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      // Probe SELECT finds no row → deleted
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(resumeWorkflowRun('nonexistent-id')).rejects.toThrow(
        'Workflow run not found (id: nonexistent-id)'
      );
    });

    test('throws "not resumable" when the run was concurrently activated (CAS miss)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running', metadata: {} }]));
      // UPDATE matches nothing because the row is already 'running'
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
      // Probe SELECT reveals the current status
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running' }]));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Workflow run is not resumable (id: workflow-run-123, status: running)'
      );
    });

    test('throws on database error during the disambiguation probe', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running', metadata: {} }]));
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0)); // UPDATE matched nothing
      mockQuery.mockRejectedValueOnce(new Error('Connection lost')); // probe fails

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to resume workflow run: Connection lost'
      );
    });

    test('throws on database error during UPDATE', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running', metadata: {} }]));
      mockQuery.mockRejectedValueOnce(new Error('Lock timeout'));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to resume workflow run: Lock timeout'
      );
    });

    test('throws on database error during the pre-CAS read', async () => {
      // The read shares the CAS's try/catch — a failure there must surface as the
      // same resume error, and the transaction rolls back with nothing written.
      mockQuery.mockRejectedValueOnce(new Error('Lock timeout'));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to resume workflow run: Lock timeout'
      );
    });

    test('throws on database error during SELECT after UPDATE', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running', metadata: {} }]));
      // UPDATE succeeds
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // SELECT fails
      mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to resume workflow run: Connection lost'
      );
    });

    test('throws when row vanishes between UPDATE and SELECT', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running', metadata: {} }]));
      // UPDATE succeeds (rowCount 1)
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // SELECT returns nothing (row deleted between statements)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Workflow run vanished after update (id: workflow-run-123)'
      );
    });
  });
});
