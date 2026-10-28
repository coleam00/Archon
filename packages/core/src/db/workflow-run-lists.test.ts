// @archon-test-isolated
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';
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
  listDashboardRuns,
  listWorkflowRuns,
  findOpenWorkRuns,
  findAdoptingRuns,
} from './workflow-run-lists';

describe('workflow run lists', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  describe('listDashboardRuns', () => {
    test('derives active nodes from canonical retries and skip terminals', async () => {
      mockQuery
        .mockResolvedValueOnce(
          createQueryResult([
            {
              ...mockWorkflowRun,
              codebase_name: 'Archon',
              platform_type: 'web',
              worker_platform_id: 'worker-1',
              parent_platform_id: null,
              agents_completed: 0,
              agents_failed: 0,
              agents_total: null,
            },
          ])
        )
        .mockResolvedValueOnce(createQueryResult([{ status: 'running', cnt: '1' }]))
        .mockResolvedValueOnce(
          createQueryResult([
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'implement',
              event_type: 'node_started',
            },
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'implement',
              event_type: 'node_failed',
            },
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'implement',
              event_type: 'node_started',
            },
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'conditional',
              event_type: 'node_started',
            },
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'conditional',
              event_type: 'node_skipped',
            },
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'cached',
              event_type: 'node_started',
            },
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'cached',
              event_type: 'node_skipped_prior_success',
            },
          ])
        );

      const result = await listDashboardRuns({ status: 'running' });

      expect(result.runs[0]).toMatchObject({
        active_nodes: ['implement'],
        current_step_name: 'implement',
        current_step_status: 'running',
        total_steps: null,
      });
      const listSql = String(mockQuery.mock.calls[0]?.[0]);
      expect(listSql).not.toContain('step_started');
      expect(listSql).not.toContain('step_completed');
      expect(listSql).not.toContain('step_failed');
    });

    test('reads PostgreSQL text counts as numbers', async () => {
      mockQuery
        .mockResolvedValueOnce(
          createQueryResult([
            {
              ...mockWorkflowRun,
              codebase_name: null,
              platform_type: null,
              worker_platform_id: null,
              parent_platform_id: null,
              agents_completed: '2',
              agents_failed: '1',
              agents_total: null,
            },
          ])
        )
        .mockResolvedValueOnce(createQueryResult([{ status: 'running', cnt: '1' }]))
        .mockResolvedValueOnce(createQueryResult([]));

      const result = await listDashboardRuns();

      expect(result.runs[0]).toMatchObject({
        agents_completed: 2,
        agents_failed: 1,
        agents_total: null,
      });
    });

    test('does not collapse parallel active nodes into the singular compatibility fields', async () => {
      mockQuery
        .mockResolvedValueOnce(
          createQueryResult([
            {
              ...mockWorkflowRun,
              codebase_name: 'Archon',
              platform_type: 'web',
              worker_platform_id: 'worker-1',
              parent_platform_id: null,
              agents_completed: 0,
              agents_failed: 0,
              agents_total: null,
            },
          ])
        )
        .mockResolvedValueOnce(createQueryResult([{ status: 'running', cnt: '1' }]))
        .mockResolvedValueOnce(
          createQueryResult([
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'parallel-a',
              event_type: 'node_started',
            },
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'parallel-b',
              event_type: 'node_started',
            },
          ])
        );

      const result = await listDashboardRuns();

      expect(result.runs[0]).toMatchObject({
        active_nodes: ['parallel-a', 'parallel-b'],
        current_step_name: null,
        current_step_status: null,
        total_steps: null,
      });
    });

    test('returns empty active state when all observed nodes are terminal', async () => {
      mockQuery
        .mockResolvedValueOnce(
          createQueryResult([
            {
              ...mockWorkflowRun,
              codebase_name: 'Archon',
              platform_type: 'web',
              worker_platform_id: 'worker-1',
              parent_platform_id: null,
              agents_completed: 0,
              agents_failed: 0,
              agents_total: null,
            },
          ])
        )
        .mockResolvedValueOnce(createQueryResult([{ status: 'running', cnt: '1' }]))
        .mockResolvedValueOnce(
          createQueryResult([
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'plan',
              event_type: 'node_started',
            },
            {
              workflow_run_id: mockWorkflowRun.id,
              step_name: 'plan',
              event_type: 'node_completed',
            },
          ])
        );

      const result = await listDashboardRuns();

      expect(result.runs[0]).toMatchObject({
        active_nodes: [],
        current_step_name: null,
        current_step_status: null,
        total_steps: null,
      });
    });

    test('binds the parent set once in both listing and counts, retaining other filters', async () => {
      const parentRunIds = ['00000000-0000-4000-8000-000000000001'];
      await listDashboardRuns({ parentRunIds, status: 'running', limit: 0 });
      const [listSql, listParams] = mockQuery.mock.calls[0]!;
      const [countSql, countParams] = mockQuery.mock.calls[1]!;
      expect(listSql).toContain(
        'r.parent_run_id IN (SELECT value::uuid FROM json_array_elements_text($2::json) AS parents(value))'
      );
      expect(countSql).toContain(
        'r.parent_run_id IN (SELECT value::uuid FROM json_array_elements_text($1::json) AS parents(value))'
      );
      expect(listSql).toContain('r.status IN ($1)');
      expect(countSql).not.toContain('r.status IN');
      expect(listParams).toEqual(['running', JSON.stringify(parentRunIds), 0, 0]);
      expect(countParams).toEqual([JSON.stringify(parentRunIds)]);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('excludes selected leaf statuses in both rows and counts', async () => {
      await listDashboardRuns({ excludeLeafStatuses: ['completed', 'cancelled'], limit: 0 });
      for (const [sql, params] of mockQuery.mock.calls) {
        expect(sql).toContain('r.status NOT IN ($1, $2)');
        expect(sql).toContain(
          'EXISTS (SELECT 1 FROM remote_agent_workflow_runs child WHERE child.parent_run_id = r.id)'
        );
        expect(params).toEqual(expect.arrayContaining(['completed', 'cancelled']));
      }
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('filters by multiple statuses and totals their counts', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([])).mockResolvedValueOnce(
        createQueryResult([
          { status: 'running', cnt: '2' },
          { status: 'paused', cnt: '3' },
          { status: 'completed', cnt: '4' },
        ])
      );

      const result = await listDashboardRuns({ status: ['running', 'paused'] });

      expect(result.total).toBe(5);
      expect(String(mockQuery.mock.calls[0]?.[0])).toContain('r.status IN ($1, $2)');
      expect(mockQuery.mock.calls[0]?.[1]).toEqual(['running', 'paused', 50, 0]);
      expect(mockQuery).toHaveBeenCalledTimes(2);
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

    test('filters by the run-owned codebase', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listWorkflowRuns({
        status: ['running', 'paused'],
        codebaseId: 'cb-project-a',
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status IN ($1, $2)');
      expect(query).toContain('remote_agent_workflow_runs.codebase_id = $3');
      expect(query).not.toContain('remote_agent_conversations');
      expect(params).toEqual(['running', 'paused', 'cb-project-a', 50]);
    });

    test('returns results from query', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await listWorkflowRuns();

      expect(result).toEqual([mockWorkflowRun]);
    });
  });

  // Open-work inbox (#2747): the query IS the semantics — terminal failed runs
  // with no adopting successor — so assert the statement's shape.
  describe('open-work inbox', () => {
    test('findOpenWorkRuns filters to failed runs with no adopter', async () => {
      let capturedSql = '';
      mockQuery.mockImplementationOnce((...args: unknown[]) => {
        const sql = args[0];
        if (typeof sql !== 'string') throw new Error('Expected a SQL string');
        capturedSql = sql;
        return Promise.resolve(createQueryResult([]));
      });

      await findOpenWorkRuns({ codebaseId: 'cb-1', limit: 10 });
      expect(capturedSql).toContain("r.status = 'failed'");
      expect(capturedSql).toContain('NOT EXISTS');
      expect(capturedSql).toContain('a.adopted_from_run_id = r.id');
      expect(capturedSql).toContain('codebase_id = $1');
      expect(capturedSql).not.toContain("status IN ('paused')");
    });

    test('findAdoptingRuns reads the same column in reverse', async () => {
      let capturedSql = '';
      mockQuery.mockImplementationOnce((...args: unknown[]) => {
        const sql = args[0];
        if (typeof sql !== 'string') throw new Error('Expected a SQL string');
        capturedSql = sql;
        return Promise.resolve(createQueryResult([]));
      });

      await findAdoptingRuns('run-1');
      expect(capturedSql).toContain('adopted_from_run_id = $1');
    });
  });
});
