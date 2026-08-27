import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { WorkflowEventRow } from './workflow-events';
import { AXIS_SPECIMEN } from '../test/token-usage-axes';
import { mergeTokenUsage } from '@archon/providers/types';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  getDatabase: () => ({
    withTransaction: async <T>(fn: (query: typeof mockQuery) => Promise<T>): Promise<T> =>
      fn(mockQuery),
  }),
}));

import {
  createWorkflowEvent,
  persistWorkflowEvent,
  persistWorkflowEventIfRunning,
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

  describe('persistWorkflowEventIfRunning', () => {
    test('atomically inserts the start from a locked running row', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{}]));

      await expect(
        persistWorkflowEventIfRunning({
          workflow_run_id: 'run-456',
          event_type: 'node_started',
          step_name: 'fan-instance',
        })
      ).resolves.toEqual({ persisted: true });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0]?.[0]).toContain('INSERT INTO remote_agent_workflow_events');
      expect(mockQuery.mock.calls[0]?.[0]).toContain("status = 'running' FOR UPDATE");
    });

    test('does not persist a start after cancellation won the conditional insert', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(
        persistWorkflowEventIfRunning({
          workflow_run_id: 'run-456',
          event_type: 'node_started',
          step_name: 'fan-instance',
        })
      ).resolves.toEqual({ persisted: false });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('allows already-claimed deterministic work to extend through a pause', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{}]));

      await expect(
        persistWorkflowEventIfRunning(
          {
            workflow_run_id: 'run-456',
            event_type: 'node_started',
            step_name: 'nested-fan-instance',
          },
          { allowPaused: true }
        )
      ).resolves.toEqual({ persisted: true });

      expect(mockQuery.mock.calls[0]?.[0]).toContain("status IN ('running', 'paused') FOR UPDATE");
    });
  });

  describe('persistWorkflowEvent', () => {
    test('propagates a storage failure for correctness-critical events', async () => {
      mockQuery.mockRejectedValueOnce(new Error('disk full'));

      await expect(
        persistWorkflowEvent({
          workflow_run_id: 'run-456',
          event_type: 'fan_out_instances',
          step_name: 'fan',
          data: { instances: [] },
        })
      ).rejects.toThrow('disk full');
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
            data: {
              node_output: 'output A',
              tokens: { input: 40, output: 4, cacheRead: 20, cacheWrite: 0 },
            },
          },
          {
            step_name: 'node-b',
            event_type: 'node_completed',
            data: {
              node_output: 'output B',
              tokens: { input: 60, output: 6, cacheRead: 30, cacheWrite: 5 },
            },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-123');

      expect(result.completedNodeOutputs).toEqual(
        new Map([
          ['node-a', { output: 'output A' }],
          ['node-b', { output: 'output B' }],
        ])
      );
      expect(result.tokens).toEqual({
        input: 100,
        output: 10,
        cacheRead: 50,
        cacheWrite: 5,
      });
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('node_completed'), [
        'run-123',
      ]);
    });

    test('carries structured_output back out; rows without it stay text-only (#2637)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'typed',
            event_type: 'node_completed',
            data: { node_output: '{"green":true}', structured_output: { green: true } },
          },
          {
            step_name: 'legacy',
            event_type: 'node_completed',
            data: { node_output: 'plain text' },
          },
          {
            // A resume re-emit copies the value forward, so a SECOND resume sees it.
            step_name: 'replayed',
            event_type: 'node_skipped_prior_success',
            data: { node_output: '{"n":1}', structured_output: { n: 1 } },
          },
          {
            // `false` is a legitimate value — presence-keyed, never truthiness.
            step_name: 'falsy',
            event_type: 'node_completed',
            data: { node_output: 'false', structured_output: false },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-structured');

      expect(result.completedNodeOutputs.get('typed')).toEqual({
        output: '{"green":true}',
        structuredOutput: { green: true },
      });
      expect(result.completedNodeOutputs.get('legacy')).toEqual({ output: 'plain text' });
      expect(result.completedNodeOutputs.get('replayed')).toEqual({
        output: '{"n":1}',
        structuredOutput: { n: 1 },
      });
      expect(result.completedNodeOutputs.get('falsy')).toEqual({
        output: 'false',
        structuredOutput: false,
      });
    });

    test('reports cache from a mixed run as a floor instead of withholding it', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'legacy',
            event_type: 'node_completed',
            data: { tokens: { input: 40, output: 4 } },
          },
          {
            step_name: 'current',
            event_type: 'node_completed',
            data: { tokens: { input: 60, output: 6, cacheRead: 30, cacheWrite: 0 } },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-mixed-cache');

      // The legacy row narrows the cache total rather than erasing it; input is unchanged.
      expect(result.tokens).toEqual({
        input: 100,
        output: 10,
        cacheRead: 30,
        cacheWrite: 0,
        cachePartial: true,
      });
    });

    test('leaves cache absent and unflagged when no event reported it', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'legacy-a',
            event_type: 'node_completed',
            data: { tokens: { input: 40, output: 4 } },
          },
          {
            step_name: 'legacy-b',
            event_type: 'node_completed',
            data: { tokens: { input: 60, output: 6 } },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-all-legacy');

      // A run written entirely by a pre-#2654 build resumes exactly as before.
      expect(result.tokens).toEqual({ input: 100, output: 10 });
    });

    test('propagates a persisted cachePartial flag into the resumed total', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'loop-total',
            event_type: 'node_completed',
            data: {
              tokens: { input: 500, output: 50, cacheRead: 300, cachePartial: true },
            },
          },
          {
            step_name: 'plain',
            event_type: 'node_completed',
            data: { tokens: { input: 100, output: 10, cacheRead: 40 } },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-partial-node');

      // Every row reports cacheRead, so the axis alone looks complete — the flag
      // survives only because it round-trips through the persisted event.
      expect(result.tokens).toEqual({
        input: 600,
        output: 60,
        cacheRead: 340,
        cachePartial: true,
      });
    });

    test('includes failed-node usage without treating the failed node as completed', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'done',
            event_type: 'node_completed',
            data: {
              node_output: 'kept',
              cost_usd: 0.01,
              tokens: { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 },
            },
          },
          {
            step_name: 'retry-me',
            event_type: 'node_failed',
            data: {
              error: 'provider failed after reporting usage',
              cost_usd: 0.02,
              tokens: { input: 20, output: 2 },
            },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-failed-usage');

      expect(result.completedNodeOutputs).toEqual(new Map([['done', { output: 'kept' }]]));
      expect(result.costUsd).toBeCloseTo(0.03, 10);
      // The failed row reports no cache, so the completed row's cache survives as a floor.
      expect(result.tokens).toEqual({
        input: 30,
        output: 3,
        cacheRead: 5,
        cacheWrite: 0,
        cachePartial: true,
      });
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("'node_failed'"), [
        'run-failed-usage',
      ]);
    });

    test('a later node_failed row supersedes an earlier node_completed row for the same step (#2705 R2)', async () => {
      // Before #2705, a non-always_run node that once completed could never be
      // re-attempted, so a node_completed → node_failed sequence for the same
      // step_name was impossible. #2705's own invalidate-and-re-execute
      // mechanism is the first thing that can produce that sequence: a cached
      // node gets invalidated, re-executes, and the fresh attempt fails. If the
      // earlier node_completed entry survives in the map, the NEXT resume's
      // cache-eligibility check sees a stale success instead of the node's own
      // most recent (failed) outcome.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'flaky',
            event_type: 'node_completed',
            data: { node_output: 'first attempt succeeded' },
          },
          {
            step_name: 'flaky',
            event_type: 'node_failed',
            data: { error: 'second attempt (re-executed via invalidation) crashed' },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-completed-then-failed');

      // The failed row is the step's most recent real outcome; the stale
      // node_completed entry must not survive the chronological walk.
      expect(result.completedNodeOutputs.has('flaky')).toBe(false);
    });

    test('a node_completed row after a node_failed row for the same step re-adds it (chronological order wins)', async () => {
      // Symmetric check: if the node later succeeds (a subsequent resume re-runs
      // it and this time it completes), that success must be honoured — the
      // delete on node_failed must not leave a permanent tombstone.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'flaky',
            event_type: 'node_failed',
            data: { error: 'first attempt crashed' },
          },
          {
            step_name: 'flaky',
            event_type: 'node_completed',
            data: { node_output: 'second attempt succeeded' },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-failed-then-completed');

      expect(result.completedNodeOutputs.get('flaky')).toEqual({
        output: 'second attempt succeeded',
      });
    });

    test('sums cache axes reported by a failed node into the resumed total', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'done',
            event_type: 'node_completed',
            data: {
              node_output: 'kept',
              tokens: { input: 10, output: 1, cacheRead: 5, cacheWrite: 2 },
            },
          },
          {
            step_name: 'retry-me',
            event_type: 'node_failed',
            data: {
              error: 'provider failed after reporting usage',
              tokens: { input: 20, output: 2, cacheRead: 8, cacheWrite: 3 },
            },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-failed-cache');

      expect(result.tokens).toEqual({
        input: 30,
        output: 3,
        cacheRead: 13,
        cacheWrite: 5,
      });
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
      expect(result.completedNodeOutputs.get('node-a')).toEqual({ output: 'output A' });
      expect(result.completedNodeOutputs.get('node-b')).toEqual({ output: 'output B' });
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
      expect(result.completedNodeOutputs.get('node-x')).toEqual({ output: 'skipped output X' });
      expect(result.completedNodeOutputs.get('node-y')).toEqual({ output: 'skipped output Y' });
      expect(result.tokens).toBeUndefined();
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

      expect(result.completedNodeOutputs.get('node-a')).toEqual({ output: 'parsed output' });
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

      expect(result.completedNodeOutputs).toEqual(new Map([['node-a', { output: 'kept' }]]));
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
          ['node-c', { output: 'valid' }],
          ['node-d', { output: 'also valid' }],
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

      expect(result.completedNodeOutputs).toEqual(
        new Map([['node-a', { output: 'output without usage' }]])
      );
      expect(result.tokens).toBeUndefined();
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
      expect(result.completedNodeOutputs.get('node-a')).toEqual({ output: 'good first' });
      expect(result.completedNodeOutputs.get('node-c')).toEqual({ output: 'good last' });
      expect(result.tokens).toEqual({ input: 10, output: 3 });
    });

    // #2469: cost is restored across resume passes exactly like tokens. Before this,
    // only tokens were summed, so a resumed run's cost silently reset to the current
    // pass — and once a FAILED run started persisting cost, the figure would have gone
    // down after a successful resume.
    test('sums cost_usd from node_completed events', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 'output A', cost_usd: 0.02, tokens: { input: 40, output: 4 } },
          },
          {
            step_name: 'node-b',
            event_type: 'node_completed',
            data: { node_output: 'output B', cost_usd: 0.03 },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-cost');

      expect(result.costUsd).toBeCloseTo(0.05, 10);
      expect(result.tokens).toEqual({ input: 40, output: 4 });
    });

    test('excludes cost_usd on node_skipped_prior_success rows (multi-resume)', async () => {
      // A prior-success replay must not re-charge a node an earlier pass already
      // counted — otherwise every resume multiplies that node's cost.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 'output A', cost_usd: 0.02 },
          },
          {
            step_name: 'node-b',
            event_type: 'node_skipped_prior_success',
            data: { reason: 'prior_success', node_output: 'output B', cost_usd: 999 },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-cost-resume');

      expect(result.costUsd).toBeCloseTo(0.02, 10);
    });

    test('ignores malformed and non-finite cost_usd while keeping valid rows', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 'valid', cost_usd: 0.01 },
          },
          {
            step_name: 'node-b',
            event_type: 'node_completed',
            data: { node_output: 'string cost', cost_usd: '0.5' },
          },
          {
            step_name: 'node-c',
            event_type: 'node_completed',
            data: { node_output: 'nan cost', cost_usd: Number.NaN },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-cost-malformed');

      expect(result.costUsd).toBeCloseTo(0.01, 10);
      expect(result.completedNodeOutputs.size).toBe(3);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });

    test('does not warn when completed events omit optional cost', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'node-a',
            event_type: 'node_completed',
            data: { node_output: 'no cost reported', tokens: { input: 5, output: 1 } },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-cost-absent');

      expect(result.costUsd).toBe(0);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    // #2469: a loop_group writes a roll-up node_completed row whose cost_usd restates
    // what its own `<groupId>.<nodeId>` body rows already carry. Summing both counted
    // that group twice — the same silently-wrong number this work exists to remove,
    // pointing the other way. The roll-up is marked `aggregate: true` and skipped here.
    test('excludes usage on aggregate rows while keeping their output', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'group.body',
            event_type: 'node_completed',
            data: { node_output: 'iteration 1', cost_usd: 0.01, tokens: { input: 10, output: 1 } },
          },
          {
            step_name: 'group',
            event_type: 'node_completed',
            data: { node_output: 'last iteration', cost_usd: 0.01, aggregate: true },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-loop-group');

      // The leaves are authoritative: 0.01 total, not 0.02.
      expect(result.costUsd).toBeCloseTo(0.01, 10);
      expect(result.tokens).toEqual({ input: 10, output: 1 });
      // The roll-up still marks the group node completed, so resume skips it rather
      // than re-running the whole group.
      expect(result.completedNodeOutputs.get('group')).toEqual({ output: 'last iteration' });
      expect(result.completedNodeOutputs.get('group.body')).toEqual({ output: 'iteration 1' });
    });

    test('uses durable composed-instance summaries instead of their fallible inner rows', async () => {
      const first = '__archon_fan_out__fan__root__item-a';
      const second = '__archon_fan_out__fan__root__item-b';
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: `${first}__fan__item-a__work`,
            event_type: 'node_completed',
            data: { node_output: 'leaf', cost_usd: 0.01, tokens: { input: 10, output: 1 } },
          },
          {
            step_name: first,
            event_type: 'node_completed',
            data: {
              node_output: 'done-a',
              type: 'compose_fan_out_instance',
              aggregate: true,
              cost_usd: 0.01,
              tokens: { input: 10, output: 1 },
            },
          },
          // The second instance proves the durable summary remains sufficient when its
          // fire-and-forget leaf event never reached storage before the process died.
          {
            step_name: second,
            event_type: 'node_completed',
            data: {
              node_output: 'done-b',
              type: 'compose_fan_out_instance',
              aggregate: true,
              cost_usd: 0.02,
              tokens: { input: 20, output: 2 },
            },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-compose-accounting');

      expect(result.costUsd).toBeCloseTo(0.03, 10);
      expect(result.tokens).toEqual({ input: 30, output: 3 });
    });

    describe('node_output_spill_path preference (#2726)', () => {
      let spillDir: string;

      beforeEach(async () => {
        spillDir = await mkdtemp(join(tmpdir(), 'archon-resume-snapshot-spill-'));
      });

      afterEach(async () => {
        await rm(spillDir, { recursive: true, force: true });
      });

      test('reads the full spilled content instead of the truncated preview', async () => {
        const fullOutput = 'x'.repeat(50_000);
        const spillPath = join(spillDir, 'big-node.nodeoutput');
        await writeFile(spillPath, fullOutput);

        mockQuery.mockResolvedValueOnce(
          createQueryResult([
            {
              step_name: 'big-node',
              event_type: 'node_completed',
              data: {
                node_output: 'x'.repeat(100) + '\n\n… [truncated; original output was 50000 bytes]',
                node_output_truncated: true,
                node_output_original_bytes: 50_000,
                node_output_spill_path: spillPath,
              },
            },
          ])
        );

        const result = await getDagResumeSnapshot('run-spill');

        expect(result.completedNodeOutputs.get('big-node')?.output).toBe(fullOutput);
        expect(result.completedNodeOutputs.get('big-node')?.output.length).toBe(50_000);
      });

      test('falls back to the preview when the spill file is missing, without throwing', async () => {
        const missingPath = join(spillDir, 'does-not-exist.nodeoutput');

        mockQuery.mockResolvedValueOnce(
          createQueryResult([
            {
              step_name: 'orphaned-node',
              event_type: 'node_completed',
              data: {
                node_output: 'preview text' + '\n\n… [truncated; original output was 99999 bytes]',
                node_output_truncated: true,
                node_output_original_bytes: 99_999,
                node_output_spill_path: missingPath,
              },
            },
          ])
        );

        const snapshot = await getDagResumeSnapshot('run-spill-missing');

        expect(snapshot.completedNodeOutputs.get('orphaned-node')?.output).toBe(
          'preview text' + '\n\n… [truncated; original output was 99999 bytes]'
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ spillPath: missingPath }),
          'db.workflow_dag_node_output_spill_read_failed'
        );
      });

      test('falls back to the preview when the spill file no longer matches the recorded byte length (#2726)', async () => {
        // Simulates the crash-window race: the spill file at this path was overwritten by
        // a LATER execution of the same node (a resume re-execution via always_run or
        // stale-dependency invalidation), but this row's own event insert is the one that
        // ended up durable. The spill no longer describes what this row actually recorded.
        const spillPath = join(spillDir, 'racy-node.nodeoutput');
        await writeFile(spillPath, 'z'.repeat(12_345)); // a DIFFERENT execution's content

        mockQuery.mockResolvedValueOnce(
          createQueryResult([
            {
              step_name: 'racy-node',
              event_type: 'node_completed',
              data: {
                node_output: 'preview text' + '\n\n… [truncated; original output was 50000 bytes]',
                node_output_truncated: true,
                node_output_original_bytes: 50_000,
                node_output_spill_path: spillPath,
              },
            },
          ])
        );

        const snapshot = await getDagResumeSnapshot('run-spill-stale');

        expect(snapshot.completedNodeOutputs.get('racy-node')?.output).toBe(
          'preview text' + '\n\n… [truncated; original output was 50000 bytes]'
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            spillPath,
            expectedBytes: 50_000,
            actualBytes: 12_345,
          }),
          'db.workflow_dag_node_output_spill_stale'
        );
      });

      test('does not attempt a spill read when no spill path is recorded', async () => {
        mockQuery.mockResolvedValueOnce(
          createQueryResult([
            {
              step_name: 'small-node',
              event_type: 'node_completed',
              data: { node_output: 'small output' },
            },
          ])
        );

        const result = await getDagResumeSnapshot('run-no-spill');

        expect(result.completedNodeOutputs.get('small-node')).toEqual({ output: 'small output' });
        expect(mockLogger.warn).not.toHaveBeenCalled();
      });
    });

    test('returns an empty snapshot when no events exist', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getDagResumeSnapshot('run-empty');

      expect(result.completedNodeOutputs.size).toBe(0);
      expect(result.tokens).toBeUndefined();
      expect(result.costUsd).toBe(0);
      expect(result.fanOutSnapshots.size).toBe(0);
      expect(result.unresolvedNodeStarts.size).toBe(0);
    });

    test('keeps the first valid fan-out instance snapshot authoritative', async () => {
      const first = [
        { ordinal: 0, identity: 'a-0', item: { id: 'a' }, inputs: { item: { id: 'a' } } },
        { ordinal: 1, identity: 'b-0', item: { id: 'b' }, inputs: { item: { id: 'b' } } },
      ];
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { step_name: 'fan', event_type: 'fan_out_instances', data: { instances: first } },
          {
            step_name: 'fan',
            event_type: 'fan_out_instances',
            data: {
              instances: [
                {
                  ordinal: 0,
                  identity: 'changed-0',
                  item: 'changed',
                  inputs: { item: 'changed' },
                },
              ],
            },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-fan');

      expect(result.fanOutSnapshots.get('fan')).toEqual(first);
    });

    test('ignores a fan-out snapshot that does not carry its resolved input map', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            step_name: 'fan',
            event_type: 'fan_out_instances',
            data: { instances: [{ ordinal: 0, identity: 'incomplete', item: 'a' }] },
          },
        ])
      );

      const result = await getDagResumeSnapshot('run-incomplete-fan-plan');

      expect(result.fanOutSnapshots.has('fan')).toBe(false);
    });

    test('tracks a durable start until the same step reaches a terminal event', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { step_name: 'fan__a', event_type: 'node_started', data: {} },
          { step_name: 'fan__b', event_type: 'node_started', data: {} },
          { step_name: 'fan__b', event_type: 'node_completed', data: { node_output: 'done' } },
        ])
      );

      const result = await getDagResumeSnapshot('run-starts');

      expect(result.unresolvedNodeStarts).toEqual(new Set(['fan__a']));
    });

    test('throws on DB query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      await expect(getDagResumeSnapshot('run-error')).rejects.toThrow('connection refused');
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// TokenUsage axis seam guard (#2674) — the reader half
//
// `getDagResumeSnapshot` rebuilds a persisted `data.tokens` field by field, so
// an axis it does not know about is dropped from every resumed run's total.
// Its writer is in @archon/workflows, and that half is guarded there under the
// same block name. The two cannot share a test: the writer is only reachable by
// driving `executeDagWorkflow` through that file's own mock harness, which is
// not importable. So this side cannot be a round trip.
//
// It is pinned to `mergeTokenUsage` instead, which is the decoder's actual
// downstream contract: `getDagResumeSnapshot` folds what it decodes through
// that same function (`workflow-events.ts:335`). Any axis the fold keeps, the
// decoder must keep; any axis the fold drops is absent from both sides. That is
// strictly stronger than a hand-written key map here would be, because a map
// could be dispositioned `null` — truthfully, since the decoder really does
// drop the axis — while the writer next door carries it, and both packages
// would stay green. Pinning to the fold makes that disagreement a failure.
//
// The type anchor is `AXIS_SPECIMEN` in `src/test/token-usage-axes.ts`, NOT in
// this file: core's tsconfig excludes `**/*.test.ts` from type-check, so an
// anchor placed here would never fire. That module explains the rest.
// ───────────────────────────────────────────────────────────────────────────
describe('TokenUsage axis seam guard', () => {
  test('getDagResumeSnapshot carries every axis the fold keeps', async () => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        {
          step_name: 'node-a',
          event_type: 'node_completed',
          data: { tokens: AXIS_SPECIMEN },
        },
      ])
    );

    const { tokens } = await getDagResumeSnapshot('run-axis-seam');

    // A single contributing row keeps the fold an identity, so a lossless
    // decoder must return exactly what the fold makes of the specimen.
    expect(tokens).toEqual(mergeTokenUsage([AXIS_SPECIMEN]));
    // ...and that must be a real object, not two matching `undefined`s.
    expect(tokens).toBeDefined();
  });
});
