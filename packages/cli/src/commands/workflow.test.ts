/**
 * Tests for the maintenance commands: session reset and history cleanup.
 */
import {
  mockDeleteNodeSessions,
  spyOnJsonStdout,
  firstJsonPayload,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { workflowCleanupCommand, workflowResetSessionsCommand } from './workflow';

describe('workflowCleanupCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should print deletion count when runs are deleted', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      count: 5,
    });

    const host = createTestWorkflowHost();
    const prune = mock(async () => ({ count: 7 }));
    host.deps.store.pruneStateRevisions = prune;
    await workflowCleanupCommand(host, 30);
    expect(prune).toHaveBeenCalledWith(30);
    expect(consoleSpy).toHaveBeenCalledWith('Pruned 7 state revision(s) older than 30 days.');

    expect(consoleSpy).toHaveBeenCalledWith('Deleted 5 workflow run(s) older than 30 days.');
  });

  it('should print no-op message when count is 0', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      count: 0,
    });

    await workflowCleanupCommand(createTestWorkflowHost(), 7);

    expect(consoleSpy).toHaveBeenCalledWith('No workflow runs older than 7 days to clean up.');
  });

  it('reports committed run deletion when state pruning fails', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      count: 5,
    });
    const host = createTestWorkflowHost();
    host.deps.store.pruneStateRevisions = mock(async () => {
      throw new Error('state unavailable');
    });
    await expect(workflowCleanupCommand(host, 7)).rejects.toThrow(
      'Deleted 5 workflow run(s) older than 7 days, but failed to prune state revisions: state unavailable'
    );
  });

  it('should throw when deleteOldWorkflowRuns fails', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('disk full')
    );

    await expect(workflowCleanupCommand(createTestWorkflowHost(), 7)).rejects.toThrow(
      'Failed to clean up workflow history: disk full'
    );
  });
});

describe('workflowResetSessionsCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockDeleteNodeSessions.mockClear();
    mockDeleteNodeSessions.mockResolvedValue({ deleted: 0 });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('refuses a cross-scope reset without --scope and without --yes', async () => {
    await expect(
      workflowResetSessionsCommand(createTestWorkflowHost(), 'feature-dev', {})
    ).rejects.toThrow(/Refusing/);
    expect(mockDeleteNodeSessions).not.toHaveBeenCalled();
  });

  it('proceeds across all scopes when --yes is given (no scope filter)', async () => {
    mockDeleteNodeSessions.mockResolvedValueOnce({ deleted: 4 });

    await workflowResetSessionsCommand(createTestWorkflowHost(), 'feature-dev', { yes: true });

    expect(mockDeleteNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'feature-dev',
      scope_key: undefined,
      node_id: undefined,
    });
    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('4') && c.includes('across all scopes'))).toBe(true);
  });

  it('proceeds with --scope and no --yes, narrowing to that scope', async () => {
    mockDeleteNodeSessions.mockResolvedValueOnce({ deleted: 1 });

    await workflowResetSessionsCommand(createTestWorkflowHost(), 'feature-dev', {
      scope: 'conv-1',
      node: 'planner',
    });

    expect(mockDeleteNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'feature-dev',
      scope_key: 'conv-1',
      node_id: 'planner',
    });
  });

  it('emits machine-readable JSON when --json is set', async () => {
    mockDeleteNodeSessions.mockResolvedValueOnce({ deleted: 2 });

    await workflowResetSessionsCommand(createTestWorkflowHost(), 'feature-dev', {
      scope: 'conv-1',
      json: true,
    });

    expect(firstJsonPayload(stdoutSpy)).toBe(
      JSON.stringify({ workflow: 'feature-dev', deleted: 2, scope: 'conv-1', node: null })
    );
  });
});
