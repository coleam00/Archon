import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import { createPrdExecutionLeaseDb } from './prd-execution-leases';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
const leaseDb = createPrdExecutionLeaseDb({
  query: mockQuery,
  getDialect: () => mockPostgresDialect,
  log: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    child: mock(() => undefined),
    trace: mock(() => undefined),
    fatal: mock(() => undefined),
  } as never,
});

describe('prd-execution-leases', () => {
  const sampleLease = {
    id: 'lease-1',
    codebase_id: 'cb-1',
    prd_id: 'PRD-0045',
    workflow_run_id: 'run-1',
    workflow_name: 'prd-to-pr',
    canonical_repo_path: '/repo',
    source_branch: 'main',
    execution_branch: 'feat/prd-0045-r2',
    working_path: '/repo/.worktree/prd-0045',
    status: 'active',
    metadata: {},
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    released_at: null,
  };

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  test('getActivePrdExecutionLease returns parsed lease row', async () => {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        { ...sampleLease, metadata: JSON.stringify({ provenance: { headSha: 'abc123' } }) },
      ])
    );

    const result = await leaseDb.getActivePrdExecutionLease('cb-1', 'PRD-0045');

    expect(result).toEqual({
      ...sampleLease,
      metadata: { provenance: { headSha: 'abc123' } },
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM remote_agent_prd_execution_leases'),
      ['cb-1', 'PRD-0045']
    );
  });

  test('getPrdExecutionLeaseByRunId returns null when missing', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([]));

    const result = await leaseDb.getPrdExecutionLeaseByRunId('missing-run');

    expect(result).toBeNull();
  });

  test('acquirePrdExecutionLease inserts when no active lease exists', async () => {
    mockQuery
      .mockResolvedValueOnce(createQueryResult([]))
      .mockResolvedValueOnce(createQueryResult([sampleLease]));

    const result = await leaseDb.acquirePrdExecutionLease({
      codebase_id: 'cb-1',
      prd_id: 'PRD-0045',
      workflow_run_id: 'run-1',
      workflow_name: 'prd-to-pr',
      canonical_repo_path: '/repo',
      source_branch: 'main',
      execution_branch: 'feat/prd-0045-r2',
      working_path: '/repo/.worktree/prd-0045',
      metadata: { provenance: { headSha: 'abc123' } },
    });

    expect(result).toEqual(sampleLease);
    expect(mockQuery.mock.calls[1]?.[0]).toContain('INSERT INTO remote_agent_prd_execution_leases');
    expect(mockQuery.mock.calls[1]?.[1]).toEqual([
      'cb-1',
      'PRD-0045',
      'run-1',
      'prd-to-pr',
      '/repo',
      'main',
      'feat/prd-0045-r2',
      '/repo/.worktree/prd-0045',
      JSON.stringify({ provenance: { headSha: 'abc123' } }),
    ]);
  });

  test('acquirePrdExecutionLease rejects conflicting active run', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([sampleLease]));

    await expect(
      leaseDb.acquirePrdExecutionLease({
        codebase_id: 'cb-1',
        prd_id: 'PRD-0045',
        workflow_run_id: 'run-2',
        workflow_name: 'prd-to-pr',
        canonical_repo_path: '/repo',
        source_branch: 'main',
        execution_branch: 'feat/prd-0045-r2',
      })
    ).rejects.toThrow("already has an active lease held by run 'run-1'");
  });

  test('acquirePrdExecutionLease refreshes existing same-run lease', async () => {
    mockQuery
      .mockResolvedValueOnce(createQueryResult([sampleLease]))
      .mockResolvedValueOnce(
        createQueryResult([
          { ...sampleLease, metadata: JSON.stringify({ provenance: { headSha: 'def456' } }) },
        ])
      );

    const result = await leaseDb.acquirePrdExecutionLease({
      codebase_id: 'cb-1',
      prd_id: 'PRD-0045',
      workflow_run_id: 'run-1',
      workflow_name: 'prd-to-pr',
      canonical_repo_path: '/repo',
      source_branch: 'main',
      execution_branch: 'feat/prd-0045-r2',
      working_path: '/repo/.worktree/prd-0045',
      metadata: { provenance: { headSha: 'def456' } },
    });

    expect(mockQuery.mock.calls[1]?.[0]).toContain('UPDATE remote_agent_prd_execution_leases');
    expect(result?.metadata).toEqual({ provenance: { headSha: 'def456' } });
  });

  test('updatePrdExecutionLeaseStatus updates paused lease', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

    await leaseDb.updatePrdExecutionLeaseStatus('run-1', 'paused', { paused_at: 'now' });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SET status = $1'), [
      'paused',
      JSON.stringify({ paused_at: 'now' }),
      'run-1',
    ]);
  });

  test('releasePrdExecutionLease updates terminal status and released_at', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

    await leaseDb.releasePrdExecutionLease('run-1', 'completed', { completed_at: 'now' });

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('released_at = NOW()'), [
      'completed',
      JSON.stringify({ completed_at: 'now' }),
      'run-1',
    ]);
  });
});
