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
    // The pre-transaction artifact read finds no run, so no artifacts are walked.
    query: () => Promise.resolve(createQueryResult([])),
    withTransaction: <T>(fn: (query: typeof mockQuery) => Promise<T>): Promise<T> => fn(mockQuery),
  }),
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import {
  pauseWorkflowRun,
  resolveAndCancelApprovalGate,
  resolveApprovalGate,
} from './workflow-run-gates';

describe('workflow run gates', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  test('resolution binds the expected gate node in the PostgreSQL CAS', async () => {
    const metadata = { approval: { nodeId: 'review', resolved: 'approved' } };
    expect(await resolveApprovalGate('run-1', metadata, [], 'review')).toEqual({ resolved: false });
    expect(mockQuery.mock.calls[0]?.[0]).toContain("metadata->'approval'->>'nodeId' = $3");
    expect(mockQuery.mock.calls[0]?.[1]).toEqual([
      'run-1',
      JSON.stringify(metadata),
      'review',
      null,
    ]);
  });

  test('terminal rejection binds the expected gate node in the PostgreSQL CAS', async () => {
    expect(
      await resolveAndCancelApprovalGate('run-1', [], { step_name: 'review' }, 'review')
    ).toEqual({ resolved: false });
    expect(mockQuery.mock.calls[0]?.[0]).toContain("metadata->'approval'->>'nodeId' = $2");
    expect(mockQuery.mock.calls[0]?.[1]).toEqual(['run-1', 'review', null]);
  });

  describe('pauseWorkflowRun', () => {
    test('replaces the approval object rather than merging into it', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await pauseWorkflowRun('workflow-run-123', {
        nodeId: 'review',
        message: 'Please review',
        type: 'approval',
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'paused'");
      expect(query).toContain("AND status = 'running'");
      // The approval object is SET wholesale, never folded into the stored one —
      // this suite runs the Postgres dialect, so it pins that branch of
      // writeApprovalMetadata (#2673). Top-level run metadata still merges.
      expect(query).toContain(
        "metadata = jsonb_set((metadata || $2::jsonb) - 'wait', '{approval}', $3::jsonb, true)"
      );

      // $2 is run-level metadata (only the pause cause here); $3 is the complete gate
      // context, bound separately so the replace can target it.
      expect(JSON.parse(params[1] as string)).toEqual({ pause_cause: 'gate' });
      // Exactly what the caller passed — no explicit-null reset list. Every field
      // this gate leaves unset is absent, which is what makes a prior gate's value
      // unable to survive at any depth.
      expect(JSON.parse(params[2] as string)).toEqual({
        nodeId: 'review',
        message: 'Please review',
        type: 'approval',
      });
    });

    test('preserves interactive-loop signal and usage fields when the gate provides them', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await pauseWorkflowRun('workflow-run-123', {
        nodeId: 'refine',
        message: 'gate',
        type: 'interactive_loop',
        iteration: 1,
        completionSignaled: true,
        signaledOutput: 'REPORT',
        signaledTokens: { input: 40, output: 4, cacheRead: 20, cacheWrite: 0 },
        signaledCostUsd: 0.02,
        commandSnapshot: 'Loaded command body',
      });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      const approval = JSON.parse(params[2] as string) as Record<string, unknown>;
      expect(approval.completionSignaled).toBe(true);
      expect(approval.signaledOutput).toBe('REPORT');
      expect(approval.signaledTokens).toEqual({
        input: 40,
        output: 4,
        cacheRead: 20,
        cacheWrite: 0,
      });
      expect(approval.signaledCostUsd).toBe(0.02);
      expect(approval.commandSnapshot).toBe('Loaded command body');
      expect(approval.resolved).toBeUndefined();
    });

    test('folds caller-supplied run metadata into the same write', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await pauseWorkflowRun(
        'workflow-run-123',
        { nodeId: '__writeback__', message: 'Apply changes?', type: 'writeback' },
        { pending_writeback: true }
      );

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      // Same atomic UPDATE, so there is no window where the run is paused
      // without the marker (M3) — it merges at the top level, beside `approval`.
      expect(JSON.parse(params[1] as string)).toEqual({
        pending_writeback: true,
        pause_cause: 'gate',
      });
      expect((JSON.parse(params[2] as string) as { nodeId: string }).nodeId).toBe('__writeback__');
    });

    test('throws when the run is not running', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(
        pauseWorkflowRun('workflow-run-123', { nodeId: 'review', message: 'Please review' })
      ).rejects.toThrow('not found or not in running state');
    });
  });
});
