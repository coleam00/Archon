// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { mockWorkflowRun } from '../test/mocks/workflow-run';

const mockQuery = createMockQuery();

// Mock the connection module before importing the module under test.
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import {
  getWorkflowRun,
  getWorkflowRunStatus,
  WorkflowStatusReadError,
  getActiveWorkflowRun,
  getActiveWorkflowRunByPath,
  findChildRuns,
  getRunAncestry,
} from './workflow-run-reads';

describe('workflow run reads', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  describe('getWorkflowRun', () => {
    test('returns workflow run by id', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await getWorkflowRun('workflow-run-123');

      expect(result).toEqual(mockWorkflowRun);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT *, CAST(origin AS TEXT) AS origin FROM remote_agent_workflow_runs WHERE id = $1',
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
    test.each(workflowRunStatusSchema.options)('returns stored status %s', async status => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status }]));

      const result = await getWorkflowRunStatus('workflow-run-123');

      expect(result).toBe(status);
      expect(mockQuery).toHaveBeenCalledTimes(1);
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

    test.each(['unexpected', ''])('rejects unsupported stored status %j', async status => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status }]));
      const read = getWorkflowRunStatus('workflow-run-123');
      await expect(read).rejects.toBeInstanceOf(WorkflowStatusReadError);
      await expect(read).rejects.toMatchObject({
        name: 'WorkflowStatusReadError',
        workflowRunId: 'workflow-run-123',
        storedStatus: status,
        message: `Unsupported workflow run status for run workflow-run-123: ${JSON.stringify(status)}`,
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
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

  describe('error handling', () => {
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

    // #2121 Phase 2: the ancestor chain of a shared-checkout sub-run must not
    // count as a lock — each id gets its own positional placeholder (no array
    // binding, works on both dialects).
    test('excludes ancestor run ids via NOT IN with positional placeholders', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const startedAt = new Date('2026-04-14T10:00:00Z');

      await getActiveWorkflowRunByPath('/repo/path', {
        id: 'child-id',
        startedAt,
        excludeRunIds: ['parent-id', 'grandparent-id'],
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('id != $2');
      expect(query).toContain('id NOT IN ($3, $4)');
      // The tiebreaker's id comparison must reference SELF ($2) — a positional
      // back-reference once pointed it at $4 (an ancestor id) when excludeRunIds
      // params landed between the self id and startedAt.
      expect(query).toContain('started_at = $5::timestamptz AND id < $2');
      expect(params).toEqual([
        '/repo/path',
        'child-id',
        'parent-id',
        'grandparent-id',
        startedAt.toISOString(),
      ]);
    });

    test('omits the NOT IN clause when excludeRunIds is empty', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getActiveWorkflowRunByPath('/repo/path', {
        id: 'child-id',
        startedAt: new Date(),
        excludeRunIds: [],
      });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).not.toContain('NOT IN');
    });
  });

  describe('findChildRuns', () => {
    test('selects by parent_run_id ordered oldest-first', async () => {
      const child = { ...mockWorkflowRun, id: 'child-1', parent_run_id: 'parent-1' };
      mockQuery.mockResolvedValueOnce(createQueryResult([child]));

      const result = await findChildRuns('parent-1');

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('child-1');
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('WHERE parent_run_id = $1');
      // The executor's re-entry picks children[children.length - 1] as "most
      // recent" — that only holds because this ORDER BY pins oldest-first.
      expect(query).toContain('ORDER BY started_at ASC');
      expect(params).toEqual(['parent-1']);
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('boom'));

      await expect(findChildRuns('parent-1')).rejects.toThrow(
        'Failed to find child workflow runs: boom'
      );
    });
  });

  describe('getRunAncestry', () => {
    const runRow = (id: string, parentRunId: string | null) => ({
      ...mockWorkflowRun,
      id,
      parent_run_id: parentRunId,
    });

    test('walks parent_run_id to the root, nearest ancestor first', async () => {
      // child -> parent -> root (each lookup is one getWorkflowRun query).
      mockQuery.mockResolvedValueOnce(createQueryResult([runRow('child', 'parent')]));
      mockQuery.mockResolvedValueOnce(createQueryResult([runRow('parent', 'root')]));
      mockQuery.mockResolvedValueOnce(createQueryResult([runRow('root', null)]));

      const result = await getRunAncestry('child');

      expect(result.map(r => r.id)).toEqual(['parent', 'root']);
    });

    test('stops on cyclic parent data instead of looping forever', async () => {
      // child -> parent -> child (hand-edited/corrupt DB).
      mockQuery.mockResolvedValueOnce(createQueryResult([runRow('child', 'parent')]));
      mockQuery.mockResolvedValueOnce(createQueryResult([runRow('parent', 'child')]));

      const result = await getRunAncestry('child');

      expect(result.map(r => r.id)).toEqual(['parent']);
    });

    test('ends the chain at a deleted parent (ON DELETE SET NULL orphan)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([runRow('child', 'gone')]));
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getRunAncestry('child');

      expect(result).toEqual([]);
    });
  });
});
