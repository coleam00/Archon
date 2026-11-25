/**
 * Tests for the session reset maintenance command.
 */
import {
  mockDeleteNodeSessions,
  spyOnJsonStdout,
  firstJsonPayload,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { workflowResetSessionsCommand } from './workflow';

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
